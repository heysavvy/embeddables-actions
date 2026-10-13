import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
// * Vendored parser: this file runs from the action checkout, which has no node_modules.
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

export function previewDeployHeaders({ projectId, deployKey, appSlug, branch, sha, committedAt }) {
  const key = typeof deployKey === 'string' ? deployKey.trim() : ''
  if (!key) {
    throw new Error('Pass deploy-key from the repository secret EMBEDDABLES_DEPLOY_KEY.')
  }
  return {
    'content-type': 'application/gzip',
    authorization: `Bearer ${key}`,
    'x-project-id': projectId,
    'x-hosting-app': appSlug,
    'x-git-branch': branch,
    'x-git-sha': sha,
    ...(committedAt ? { 'x-git-commit-time': committedAt } : {}),
  }
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

export function packPreviewArchive(files) {
  const chunks = []
  for (const file of files) {
    const name = file.name.split(sep).join('/')
    if (name.length > 100) throw new Error(`Archive path is longer than 100 characters: ${name}`)
    const data = file.bytes
    chunks.push(tarHeader(name, data.length))
    chunks.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

export function filesUnder(root, directory, prefix) {
  const base = join(root, directory)
  const files = []
  walk(base, (full) => {
    const name = `${prefix}/${relative(base, full).split(sep).join('/')}`
    files.push({ name, bytes: readFileSync(full) })
  })
  return files
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

function walk(directory, visit) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Build directory was not found: ${directory}`, { cause: error })
    }
    throw error
  }
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walk(full, visit)
    else if (entry.isFile() || statSync(full).isFile()) visit(full)
  }
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 'ascii')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = 48
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  writeOctal(header, 148, 8, sum)
  return header
}

function writeOctal(buffer, offset, length, value) {
  const text = value
    .toString(8)
    .padStart(length - 1, '0')
    .slice(-(length - 1))
  buffer.write(text, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
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

  const files = [
    ...filesUnder(root, app.server, 'server'),
    ...filesUnder(root, app.client, 'client'),
  ]
  if (!files.some((file) => file.name.startsWith('server/'))) {
    throw new Error('The server directory has no files.')
  }
  const body = gzipSync(packPreviewArchive(files))
  const origin = (
    process.env.INPUT_API_ORIGIN || 'https://backend.embeddables.com'
  ).replace(/\/$/, '')
  const response = await fetch(`${origin}/hosting/v1/deploys`, {
    method: 'POST',
    body,
    headers: previewDeployHeaders({
      projectId,
      deployKey,
      appSlug: app.slug,
      branch,
      sha,
      committedAt:
        pullNumber === null
          ? eventText
            ? pushCommitTime(eventText, sha)
            : null
          : await fetchCommitTime({
              token: process.env.GITHUB_TOKEN,
              repository: process.env.GITHUB_REPOSITORY,
              sha,
            }),
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = payload.detail || payload.title || response.statusText
    throw new Error(`Deploy failed (${response.status}): ${detail}`)
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
      `branch-url=${payload.branchUrl}\ncommit-url=${payload.commitUrl}\n`,
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
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
