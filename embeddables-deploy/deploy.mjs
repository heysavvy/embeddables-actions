import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// * Vendored modules: this file runs from the action checkout, which has no node_modules.
import { DEFAULT_API_ORIGIN, DeployError, deployHostingApp } from './vendor/deploy.mjs'
import { parseDocument } from './vendor/yaml.mjs'

const API_VERSION = '2022-11-28'
const HOSTING_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const APP_KEYS = new Set(['slug', 'server', 'client'])

export function readPreviewConfig(text, appSlug) {
  const document = parseConfigDocument(text)
  const projectId = document.projectId
  if (typeof projectId !== 'string' || projectId === '') {
    throw new Error('embeddables/config.yaml has no projectId.')
  }

  const apps = hostingApps(document.hosting)
  if (apps.length === 0) throw new Error('embeddables/config.yaml has no hosting apps.')
  const seen = new Set()
  for (const app of apps) {
    if (seen.has(app.slug)) {
      throw new Error(`embeddables/config.yaml hosting.apps contains duplicate slug "${app.slug}".`)
    }
    seen.add(app.slug)
  }
  const wanted = appSlug?.trim()
  const app = wanted
    ? apps.find((item) => item.slug === wanted)
    : apps.length === 1
      ? apps[0]
      : null
  if (!app) {
    throw new Error(
      wanted
        ? `Hosting app ${wanted} is not in embeddables/config.yaml.`
        : 'Pass the app input when embeddables/config.yaml lists more than one hosting app.',
    )
  }
  return { projectId, app }
}

/** Options for `deployHostingApp`, with build folders resolved from the repository root. */
export function deployOptions({ root, projectId, app, deployKey, branch, sha, committedAt, apiOrigin }) {
  const key = typeof deployKey === 'string' ? deployKey.trim() : ''
  if (!key) {
    throw new Error('Pass deploy-key from the repository secret EMBEDDABLES_DEPLOY_KEY.')
  }
  return {
    deployKey: key,
    projectId,
    appSlug: app.slug,
    branch,
    sha,
    ...(committedAt ? { committedAt } : {}),
    serverDir: join(root, app.server),
    clientDir: join(root, app.client),
    apiOrigin: (apiOrigin || DEFAULT_API_ORIGIN).replace(/\/$/, ''),
  }
}

export function deployFailureMessage(error) {
  if (error instanceof DeployError) {
    const status = error.status === null ? '' : ` (${error.status}${error.code ? ` ${error.code}` : ''})`
    return `Deploy failed${status}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** Head commit time from the push event, so out-of-order deploys never move an alias back. */
export function pushCommitTime(eventJson, sha) {
  try {
    const event = JSON.parse(eventJson)
    const head = event?.head_commit
    if (head && head.id === sha && typeof head.timestamp === 'string') return head.timestamp
  } catch {
    return null
  }
  return null
}

/** Marker of comments written before markers were per app. */
export const COMMENT_MARKER = '<!-- embeddables-deploy -->'

export function commentMarker(appSlug) {
  return `<!-- embeddables-deploy:${appSlug} -->`
}

export function previewComment({ appSlug, sha, branchUrl, commitUrl }) {
  return `**${appSlug}** preview: ${branchUrl}\n\n${sha}\n\nCommit preview: ${commitUrl}\n\n${commentMarker(appSlug)}\n`
}

/**
 * The action's earlier comment for this app on the pull request, if any, so a
 * new deploy edits it in place. Each app in a repo keeps its own comment.
 */
export function findPreviewComment(comments, appSlug) {
  if (!Array.isArray(comments)) return null
  const bots = comments.filter((comment) => comment?.user?.type === 'Bot')
  return (
    bots.find((comment) => comment.body?.includes(commentMarker(appSlug))) ??
    bots.find((comment) => comment.body?.includes(COMMENT_MARKER)) ??
    null
  )
}

function parseConfigDocument(text) {
  const parsed = parseDocument(text, { uniqueKeys: true })
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0]?.message ?? 'embeddables/config.yaml could not be parsed.')
  }
  const document = parsed.toJSON()
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('embeddables/config.yaml must be a top-level mapping.')
  }
  return document
}

function hostingApps(hosting) {
  if (hosting == null) return []
  if (typeof hosting !== 'object' || Array.isArray(hosting)) {
    throw new Error('embeddables/config.yaml hosting must be a mapping.')
  }
  for (const key of Object.keys(hosting)) {
    if (key !== 'apps') {
      throw new Error(`embeddables/config.yaml hosting contains unknown key "${key}".`)
    }
  }
  if (hosting.apps == null) return []
  if (!Array.isArray(hosting.apps)) {
    throw new Error('embeddables/config.yaml hosting.apps must be a sequence.')
  }
  return hosting.apps.map((item, index) => validateHostingApp(item, index))
}

function validateHostingApp(app, index) {
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    throw new Error(`embeddables/config.yaml hosting.apps[${index}] must be a mapping.`)
  }
  for (const key of Object.keys(app)) {
    if (!APP_KEYS.has(key)) {
      throw new Error(
        `embeddables/config.yaml hosting.apps[${index}] contains unknown key "${key}".`,
      )
    }
  }
  const slug = app.slug
  if (typeof slug !== 'string' || slug.length < 3 || slug.length > 12 || !HOSTING_SLUG.test(slug)) {
    throw new Error(`embeddables/config.yaml hosting.apps[${index}].slug must be a hosting slug.`)
  }
  return {
    slug,
    server: relativeDir(app.server, `hosting.apps[${index}].server`),
    client: relativeDir(app.client, `hosting.apps[${index}].client`),
  }
}

function relativeDir(value, context) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`embeddables/config.yaml ${context} must be a non-empty string.`)
  }
  const parts = value.split('/')
  if (value.startsWith('/') || parts.includes('..') || parts.includes('')) {
    throw new Error(`embeddables/config.yaml ${context} must be a relative path.`)
  }
  return value
}

async function main() {
  const root = process.env.GITHUB_WORKSPACE || process.cwd()
  const configPath = join(root, process.env.INPUT_CONFIG || 'embeddables/config.yaml')
  const { projectId, app } = readPreviewConfig(
    readFileSync(configPath, 'utf8'),
    process.env.INPUT_APP,
  )
  const eventText = process.env.GITHUB_EVENT_PATH
    ? readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')
    : null
  const target = deployTarget(process.env, eventText)
  if (target.skip) {
    console.log(`::notice::${target.skip}`)
    return
  }
  const { branch, sha, pullNumber } = target
  const deployKey = process.env.INPUT_DEPLOY_KEY
  if (process.env.GITHUB_ACTIONS && typeof deployKey === 'string' && deployKey.trim()) {
    // * Action inputs are not masked even when the value came from secrets.
    console.log(`::add-mask::${deployKey.trim()}`)
  }

  const committedAt =
    pullNumber === null
      ? eventText
        ? pushCommitTime(eventText, sha)
        : null
      : await fetchCommitTime({
          token: process.env.GITHUB_TOKEN,
          repository: process.env.GITHUB_REPOSITORY,
          sha,
        })
  const payload = await deployHostingApp(
    deployOptions({
      root,
      projectId,
      app,
      deployKey,
      branch,
      sha,
      committedAt,
      apiOrigin: process.env.INPUT_API_ORIGIN,
    }),
  )
  console.log(`Uploaded ${payload.uploadedFiles} of ${payload.totalFiles} files.`)
  if (payload.appRegistered) {
    console.log(`::notice::Registered new hosting app ${payload.appSlug}.`)
  }

  const appSlug = payload.appSlug ?? app.slug
  const comment = previewComment({
    appSlug,
    sha,
    branchUrl: payload.branchUrl,
    commitUrl: payload.commitUrl,
  })
  console.log(comment.trim())
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `branch-url=${payload.branchUrl}\ncommit-url=${payload.commitUrl}\n` +
        `uploaded-files=${payload.uploadedFiles}\ntotal-files=${payload.totalFiles}\n`,
    )
  }
  await commentOnPulls({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    sha,
    pullNumber,
    appSlug,
    body: comment,
  })
}

/**
 * Branch, commit, and pull request to deploy for this run. On a pull request
 * event GITHUB_REF_NAME is `<n>/merge` and GITHUB_SHA is a merge commit, so
 * both come from the pull request head instead.
 */
export function deployTarget(env, eventText) {
  const isPullEvent = env.GITHUB_EVENT_NAME === 'pull_request'
  if (!isPullEvent) {
    if (!env.GITHUB_REF_NAME || !env.GITHUB_SHA) {
      throw new Error('GITHUB_REF_NAME and GITHUB_SHA are required.')
    }
    return { branch: env.GITHUB_REF_NAME, sha: env.GITHUB_SHA, pullNumber: null }
  }
  const pull = eventText ? JSON.parse(eventText).pull_request : null
  if (!pull?.head?.ref || !pull.head.sha || typeof pull.number !== 'number') {
    throw new Error('The pull_request event has no head ref, head sha, or number.')
  }
  if (pull.head.repo?.full_name !== pull.base?.repo?.full_name) {
    return { skip: 'Skipping deploy for a pull request from a fork: it has no access to the deploy key.' }
  }
  return { branch: pull.head.ref, sha: pull.head.sha, pullNumber: pull.number }
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'embeddables-deploy',
    'X-GitHub-Api-Version': API_VERSION,
  }
}

async function fetchCommitTime({ token, repository, sha }) {
  if (!token || !repository) return null
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}`, {
    headers: githubHeaders(token),
  })
  if (!response.ok) return null
  const commit = await response.json()
  return commit?.commit?.committer?.date ?? null
}

async function commentOnPulls({ token, repository, sha, pullNumber, appSlug, body }) {
  if (!token || !repository) return
  const headers = githubHeaders(token)
  let numbers = pullNumber === null ? [] : [pullNumber]
  if (pullNumber === null) {
    const listed = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/pulls`, {
      headers,
    })
    if (!listed.ok) return
    const pulls = await listed.json()
    if (!Array.isArray(pulls)) return
    numbers = pulls.map((pull) => pull?.number).filter((number) => typeof number === 'number')
  }
  for (const number of numbers) {
    const commentsUrl = `https://api.github.com/repos/${repository}/issues/${number}/comments`
    const listed = await fetch(`${commentsUrl}?per_page=100`, { headers })
    const existing = listed.ok ? findPreviewComment(await listed.json(), appSlug) : null
    const posted = await fetch(
      existing
        ? `https://api.github.com/repos/${repository}/issues/comments/${existing.id}`
        : commentsUrl,
      {
        method: existing ? 'PATCH' : 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    )
    if (!posted.ok) throw new Error(`Comment failed (${posted.status}).`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(deployFailureMessage(error))
    process.exit(1)
  })
}
