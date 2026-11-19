import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadProjectConfig } from '../project-config.mjs'
import { DeployError } from '../vendor/deploy.mjs'

const sha = 'a'.repeat(40)
const options = {
  apiOrigin: 'https://api.example.test/',
  deployKey: 'edk_test',
  projectId: 'project-1',
  branch: 'feature/config',
  sha,
  configYaml: '{"forms":[]}',
}

test('uploads the SHA-scoped config with vendor-compatible auth and exact wire body', async () => {
  const calls = []
  await uploadProjectConfig({ ...options, fetch: async (url, init) => {
    calls.push({ url, init })
    return new Response(null, { status: 204 })
  } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.example.test/hosting/v1/project-config')
  assert.equal(calls[0].init.method, 'PUT')
  assert.deepEqual(calls[0].init.headers, {
    authorization: 'Bearer edk_test',
    'x-project-id': 'project-1',
    'content-type': 'application/json',
  })
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    branch: 'feature/config', sha, config_yaml: '{"forms":[]}',
  })
})

test('retains legacy unscoped body when sha is omitted', async () => {
  let body
  await uploadProjectConfig({ ...options, sha: undefined, fetch: async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(null, { status: 204 })
  } })
  assert.deepEqual(body, { branch: options.branch, config_yaml: options.configYaml })
})

test('retries network failures, 429 and 5xx with vendor backoff and identical body', async () => {
  const calls = []
  const delays = []
  const responses = [new Error('offline'), new Response('{}', { status: 429 }), new Response('{}', { status: 503 })]
  await uploadProjectConfig({ ...options, sleep: async (ms) => delays.push(ms), fetch: async (_url, init) => {
    calls.push(init.body)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next ?? new Response(null, { status: 204 })
  } }).then(() => assert.fail('should exhaust three attempts'), (error) => {
    assert.ok(error instanceof DeployError)
    assert.equal(error.status, 503)
  })
  assert.equal(calls.length, 3)
  assert.deepEqual(delays, [500, 1500])
  assert.ok(calls.every((body) => body === calls[0]))
})

test('eventually succeeds after retryable 429 and 5xx responses', async () => {
  const statuses = [429, 502, 204]
  const delays = []
  await uploadProjectConfig({ ...options, sleep: async (ms) => delays.push(ms), fetch: async () => {
    const status = statuses.shift()
    return new Response(null, { status })
  } })
  assert.deepEqual(statuses, [])
  assert.deepEqual(delays, [500, 1500])
})

test('does not retry a 422 JSON null problem body', async () => {
  let count = 0
  await assert.rejects(
    uploadProjectConfig({
      ...options,
      sleep: async () => assert.fail('should not retry'),
      fetch: async () => {
        count++
        return new Response('null', { status: 422, headers: { 'content-type': 'application/json' } })
      },
    }),
    (error) => error instanceof DeployError && error.status === 422,
  )
  assert.equal(count, 1)
})

test('does not retry client validation errors and preserves problem detail and code', async () => {
  let count = 0
  await assert.rejects(uploadProjectConfig({ ...options, sleep: async () => assert.fail('should not sleep'), fetch: async () => {
    count++
    return Response.json({ detail: 'Invalid config', code: 'validation.failed' }, { status: 422 })
  } }), (error) => error instanceof DeployError && error.status === 422 &&
    error.code === 'validation.failed' && error.message === 'Invalid config')
  assert.equal(count, 1)
})
