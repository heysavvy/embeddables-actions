import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMMENT_MARKER,
  commentMarker,
  deployFailureMessage,
  deployOptions,
  deployTarget,
  findPreviewComment,
  previewComment,
  pushCommitTime,
  readPreviewConfig,
} from '../deploy.mjs'
import { DeployError } from '../vendor/deploy.mjs'

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
    appSlug: 'funnel',
    sha,
    branchUrl: 'https://main-a1b2c3---funnel---alice.embd.co',
    commitUrl: 'https://aaaaaaa---funnel---alice.embd.co',
  })
  assert.equal(
    body,
    `**funnel** preview: https://main-a1b2c3---funnel---alice.embd.co\n\n${sha}\n\nCommit preview: https://aaaaaaa---funnel---alice.embd.co\n\n${commentMarker('funnel')}\n`,
  )
})

test('findPreviewComment picks the bot comment for the same app', () => {
  const funnel = { id: 2, user: { type: 'Bot' }, body: `x\n\n${commentMarker('funnel')}\n` }
  const portal = { id: 4, user: { type: 'Bot' }, body: `x\n\n${commentMarker('portal')}\n` }
  const comments = [
    { id: 1, user: { type: 'Bot' }, body: 'Summary by another bot' },
    { id: 3, user: { type: 'User' }, body: `quoting ${commentMarker('funnel')}` },
    portal,
    funnel,
  ]
  assert.equal(findPreviewComment(comments, 'funnel'), funnel)
  assert.equal(findPreviewComment(comments, 'portal'), portal)
  assert.equal(findPreviewComment(comments, 'shop'), null)
  assert.equal(findPreviewComment(null, 'funnel'), null)
})

test('findPreviewComment adopts a comment written with the old shared marker', () => {
  const legacy = { id: 5, user: { type: 'Bot' }, body: `Preview: x\n\n${COMMENT_MARKER}\n` }
  assert.equal(findPreviewComment([legacy], 'funnel'), legacy)
})

const APP = { slug: 'funnel', server: 'dist/server', client: 'dist/client' }

test('deployOptions resolves build folders and trims the deploy key', () => {
  assert.deepEqual(
    deployOptions({
      root: '/repo',
      projectId: PROJECT_ID,
      app: APP,
      deployKey: ' edk_abc ',
      branch: 'main',
      sha: 'a'.repeat(40),
      committedAt: null,
      apiOrigin: 'https://api.example.com/',
    }),
    {
      deployKey: 'edk_abc',
      projectId: PROJECT_ID,
      appSlug: 'funnel',
      branch: 'main',
      sha: 'a'.repeat(40),
      serverDir: '/repo/dist/server',
      clientDir: '/repo/dist/client',
      apiOrigin: 'https://api.example.com',
    },
  )
  assert.throws(
    () => deployOptions({ root: '/repo', projectId: PROJECT_ID, app: APP, deployKey: '  ' }),
    /EMBEDDABLES_DEPLOY_KEY/,
  )
})

test('deployOptions sends the commit time when known and defaults the origin', () => {
  const options = deployOptions({
    root: '/repo',
    projectId: PROJECT_ID,
    app: APP,
    deployKey: 'edk_abc',
    branch: 'main',
    sha: 'a'.repeat(40),
    committedAt: '2026-10-12T15:00:00-03:00',
    apiOrigin: '',
  })
  assert.equal(options.committedAt, '2026-10-12T15:00:00-03:00')
  assert.equal(options.apiOrigin, 'https://backend.embeddables.com')
})

test('deployFailureMessage includes the API status and code', () => {
  assert.equal(
    deployFailureMessage(new DeployError('Deploy key is invalid.', { status: 401, code: 'unauthorized' })),
    'Deploy failed (401 unauthorized): Deploy key is invalid.',
  )
  assert.equal(
    deployFailureMessage(new DeployError('Server build has no files.')),
    'Deploy failed: Server build has no files.',
  )
  assert.equal(deployFailureMessage(new Error('Config not found.')), 'Config not found.')
})

test('pushCommitTime reads the head commit only when it matches the sha', () => {
  const sha = 'a'.repeat(40)
  const event = JSON.stringify({ head_commit: { id: sha, timestamp: '2026-10-12T15:00:00-03:00' } })
  assert.equal(pushCommitTime(event, sha), '2026-10-12T15:00:00-03:00')
  assert.equal(pushCommitTime(event, 'b'.repeat(40)), null)
  assert.equal(pushCommitTime('not json', sha), null)
  assert.equal(pushCommitTime('{}', sha), null)
})

test('deployTarget uses the pushed ref and sha on push', () => {
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'feature/x', GITHUB_SHA: 'a'.repeat(40) }
  assert.deepEqual(deployTarget(env, '{}'), {
    branch: 'feature/x',
    sha: 'a'.repeat(40),
    pullNumber: null,
  })
  assert.throws(() => deployTarget({ GITHUB_EVENT_NAME: 'push' }, '{}'), /GITHUB_REF_NAME/)
})

function pullEvent({ headRepo = 'acme/site', baseRepo = 'acme/site' } = {}) {
  return JSON.stringify({
    pull_request: {
      number: 7,
      head: { ref: 'feature/x', sha: 'b'.repeat(40), repo: { full_name: headRepo } },
      base: { ref: 'main', repo: { full_name: baseRepo } },
    },
  })
}

test('deployTarget uses the pull request head, not the merge ref', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF_NAME: '7/merge', GITHUB_SHA: 'c'.repeat(40) }
  assert.deepEqual(deployTarget(env, pullEvent()), {
    branch: 'feature/x',
    sha: 'b'.repeat(40),
    pullNumber: 7,
  })
})

test('deployTarget skips pull requests from forks', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request' }
  const target = deployTarget(env, pullEvent({ headRepo: 'someone/site' }))
  assert.match(target.skip, /fork/)
})

test('deployTarget rejects a pull_request event without a head', () => {
  assert.throws(
    () => deployTarget({ GITHUB_EVENT_NAME: 'pull_request' }, JSON.stringify({ pull_request: {} })),
    /head ref/,
  )
})