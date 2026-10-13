import assert from 'node:assert/strict'
import test from 'node:test'

import {
  packPreviewArchive,
  previewComment,
  previewDeployHeaders,
  pushCommitTime,
  readPreviewConfig,
} from '../deploy.mjs'

const PROJECT_ID = '00000000-0000-4000-8000-000000000001'

const CONFIG = [
  `projectId: "${PROJECT_ID}"`,
  'forms:',
  'experiments:',
  'hosting:',
  '  apps:',
  '    - slug: funnel',
  '      server: dist/server',
  '      client: dist/client',
  '',
].join('\n')

test('readPreviewConfig reads the only hosting app', () => {
  assert.deepEqual(readPreviewConfig(CONFIG), {
    projectId: PROJECT_ID,
    app: { slug: 'funnel', server: 'dist/server', client: 'dist/client' },
  })
})

test('readPreviewConfig requires the app input when several apps are listed', () => {
  const text = [
    CONFIG.trimEnd(),
    '    - slug: portal',
    '      server: dist/portal',
    '      client: dist/portal-client',
    '',
  ].join('\n')
  assert.throws(() => readPreviewConfig(text), /more than one hosting app/)
  assert.equal(readPreviewConfig(text, 'portal').app.slug, 'portal')
})

test('packPreviewArchive keeps the server and client prefixes', () => {
  const tar = packPreviewArchive([
    { name: 'server/index.js', bytes: Buffer.from('export default {}') },
    { name: 'server/wrangler.json', bytes: Buffer.from('{"main":"index.js"}') },
    { name: 'client/index.html', bytes: Buffer.from('<html></html>') },
  ])
  assert.deepEqual(tarNames(tar), ['server/index.js', 'server/wrangler.json', 'client/index.html'])
})

test('readPreviewConfig rejects an invalid slug and an unsafe path', () => {
  assert.throws(() => readPreviewConfig(CONFIG.replace('slug: funnel', 'slug: A')), /hosting slug/)
  assert.throws(
    () => readPreviewConfig(CONFIG.replace('server: dist/server', 'server: ../secret')),
    /relative path/,
  )
  assert.throws(
    () => readPreviewConfig(CONFIG.replace('client: dist/client', 'client: dist//client')),
    /relative path/,
  )
})

test('readPreviewConfig reads a dash on its own line and an inline comment', () => {
  const dashed = [
    `projectId: "${PROJECT_ID}"`,
    'hosting:',
    '  apps:',
    '    -',
    '      slug: funnel',
    '      server: dist/server',
    '      client: dist/client',
    '',
  ].join('\n')
  assert.equal(readPreviewConfig(dashed).app.slug, 'funnel')
  const commented = [
    `projectId: "${PROJECT_ID}"`,
    'hosting:',
    '  apps:',
    '    - slug: funnel # the funnel',
    '      server: dist/server',
    '      client: dist/client',
    '',
  ].join('\n')
  assert.equal(readPreviewConfig(commented).app.slug, 'funnel')
})

test('readPreviewConfig reads a flow-style hosting app', () => {
  const text = [
    `projectId: "${PROJECT_ID}"`,
    'forms:',
    'experiments:',
    'hosting: { apps: [{ slug: funnel, server: dist/server, client: dist/client }] }',
    '',
  ].join('\n')
  assert.deepEqual(readPreviewConfig(text), {
    projectId: PROJECT_ID,
    app: { slug: 'funnel', server: 'dist/server', client: 'dist/client' },
  })
  const listed = [
    `projectId: "${PROJECT_ID}"`,
    'hosting:',
    '  apps: [{ slug: funnel, server: dist/server, client: dist/client }]',
    '',
  ].join('\n')
  assert.equal(readPreviewConfig(listed).app.server, 'dist/server')
})

test('previewComment puts the branch url first and the full sha on its own line', () => {
  const sha = 'a'.repeat(40)
  const body = previewComment({
    sha,
    branchUrl: 'https://main-a1b2c3---funnel---alice.embd.co',
    commitUrl: 'https://aaaaaaa---funnel---alice.embd.co',
  })
  assert.equal(
    body,
    `Preview: https://main-a1b2c3---funnel---alice.embd.co\n\n${sha}\n\nCommit preview: https://aaaaaaa---funnel---alice.embd.co\n`,
  )
})

test('previewDeployHeaders sends the deploy key and the project id', () => {
  assert.deepEqual(
    previewDeployHeaders({
      projectId: PROJECT_ID,
      deployKey: ' edk_abc ',
      appSlug: 'funnel',
      branch: 'main',
      sha: 'a'.repeat(40),
    }),
    {
      'content-type': 'application/gzip',
      authorization: 'Bearer edk_abc',
      'x-project-id': PROJECT_ID,
      'x-hosting-app': 'funnel',
      'x-git-branch': 'main',
      'x-git-sha': 'a'.repeat(40),
    },
  )
  assert.throws(
    () => previewDeployHeaders({ projectId: PROJECT_ID, deployKey: '  ' }),
    /EMBEDDABLES_DEPLOY_KEY/,
  )
})

test('previewDeployHeaders sends the commit time when known', () => {
  const headers = previewDeployHeaders({
    projectId: PROJECT_ID,
    deployKey: 'edk_abc',
    appSlug: 'funnel',
    branch: 'main',
    sha: 'a'.repeat(40),
    committedAt: '2026-10-12T15:00:00-03:00',
  })
  assert.equal(headers['x-git-commit-time'], '2026-10-12T15:00:00-03:00')
})

test('pushCommitTime reads the head commit only when it matches the sha', () => {
  const sha = 'a'.repeat(40)
  const event = JSON.stringify({ head_commit: { id: sha, timestamp: '2026-10-12T15:00:00-03:00' } })
  assert.equal(pushCommitTime(event, sha), '2026-10-12T15:00:00-03:00')
  assert.equal(pushCommitTime(event, 'b'.repeat(40)), null)
  assert.equal(pushCommitTime('not json', sha), null)
  assert.equal(pushCommitTime('{}', sha), null)
})

function tarNames(bytes) {
  const names = []
  let offset = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*/, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*/, ''), 8)
    names.push(name)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}
