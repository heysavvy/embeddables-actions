import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const generator = fileURLToPath(new URL('../../scripts/vendor-deploy.sh', import.meta.url))

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'vendor-deploy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'embeddables-deploy/vendor'), { recursive: true })
  mkdirSync(join(root, 'packages/deploy-client/dist'), { recursive: true })
  copyFileSync(generator, join(root, 'scripts/vendor-deploy.sh'))
  writeFileSync(join(root, 'packages/deploy-client/package.json'), JSON.stringify({ name: '@embeddables/deploy', version: '0.3.1' }))
  writeFileSync(join(root, 'packages/deploy-client/dist/index.js'), 'export const fixture = 1;\n//# sourceMappingURL=index.js.map\n')
  return root
}

test('vendor generator packs a local package relative to its caller without leaking its path', (t) => {
  const root = workspace(t)
  execFileSync('bash', [join(root, 'scripts/vendor-deploy.sh'), 'packages/deploy-client'], { cwd: root })
  assert.equal(
    readFileSync(join(root, 'embeddables-deploy/vendor/deploy.mjs'), 'utf8'),
    '// Vendored from @embeddables/deploy@0.3.1 (local workspace build) by scripts/vendor-deploy.sh. Do not edit by hand.\nexport const fixture = 1;\n',
  )
})

test('vendor generator keeps the published version pack spec and portable header', (t) => {
  const root = workspace(t)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(npm, '#!/bin/sh\nprintf "%s" "$3" > "$PACK_SPEC_LOG"\nexec "$REAL_NPM" pack --silent "$FIXTURE_PACKAGE"\n')
  chmodSync(npm, 0o755)
  execFileSync('bash', [join(root, 'scripts/vendor-deploy.sh'), '0.3.1'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PACK_SPEC_LOG: join(root, 'pack-spec'),
      REAL_NPM: execFileSync('which', ['npm'], { encoding: 'utf8' }).trim(),
      FIXTURE_PACKAGE: join(root, 'packages/deploy-client'),
    },
  })
  assert.equal(readFileSync(join(root, 'pack-spec'), 'utf8'), '@embeddables/deploy@0.3.1')
  assert.equal(
    readFileSync(join(root, 'embeddables-deploy/vendor/deploy.mjs'), 'utf8'),
    '// Vendored from @embeddables/deploy@0.3.1 by scripts/vendor-deploy.sh. Do not edit by hand.\nexport const fixture = 1;\n',
  )
})