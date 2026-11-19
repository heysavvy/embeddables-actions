#!/usr/bin/env bash
# Vendor a published @embeddables/deploy build into the action.
# Usage: scripts/vendor-deploy.sh 0.1.0
set -euo pipefail

VERSION="${1:?usage: scripts/vendor-deploy.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/embeddables-deploy/vendor/deploy.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

(cd "$WORK" && npm pack --silent "@embeddables/deploy@${VERSION}" >/dev/null && tar xzf ./*.tgz)

if grep -E "^import .* from ['\"]" "$WORK/package/dist/index.js" | grep -qvE "from ['\"]node:"; then
  echo "@embeddables/deploy@${VERSION} imports a non-builtin module; it cannot be vendored as one file." >&2
  exit 1
fi

{
  echo "// Vendored from @embeddables/deploy@${VERSION} by scripts/vendor-deploy.sh. Do not edit by hand."
  grep -v '^//# sourceMappingURL=' "$WORK/package/dist/index.js"
} >"$OUT"

echo "Wrote $OUT from @embeddables/deploy@${VERSION}"
