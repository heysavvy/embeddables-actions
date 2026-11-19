// The published vendored client uploads only branch-scoped config. Keep hosting
// on that client; use the same HTTP contract here until a published client
// supports the SHA-scoped PUT.
import { DeployError } from './vendor/deploy.mjs'

export async function uploadProjectConfig(options) {
  const origin = (options.apiOrigin ?? 'https://backend.embeddables.com').replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const headers = {
    authorization: `Bearer ${options.deployKey}`,
    ...(options.projectId ? { 'x-project-id': options.projectId } : {}),
    'content-type': 'application/json',
  }
  const body = JSON.stringify({
    branch: options.branch,
    ...(options.sha ? { sha: options.sha } : {}),
    config_yaml: options.configYaml,
  })

  for (let attempt = 1; ; attempt++) {
    try {
      let response
      try {
        response = await fetchImpl(`${origin}/hosting/v1/project-config`, {
          method: 'PUT', headers, body,
        })
      } catch (cause) {
        throw new DeployError(`Could not reach ${origin}.`, { cause })
      }
      if (!response.ok) {
        let parsed = {}
        try { parsed = await response.json() } catch { /* Non-JSON problem response. */ }
        const problem = parsed !== null && typeof parsed === 'object' ? parsed : {}
        throw new DeployError(
          (typeof problem.detail === 'string' && problem.detail) ||
            (typeof problem.title === 'string' && problem.title) ||
            `Deploy request failed with ${response.status}.`,
          { status: response.status, code: typeof problem.code === 'string' ? problem.code : undefined },
        )
      }
      return
    } catch (error) {
      const status = error instanceof DeployError ? error.status : null
      if (!(status === null || status === 429 || status >= 500) || attempt >= 3) throw error
      await sleep(500 * 3 ** (attempt - 1))
    }
  }
}
