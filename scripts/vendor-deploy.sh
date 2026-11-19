#!/usr/bin/env bash
# Vendor a published @embeddables/deploy build or a locally built package.
# Usage: scripts/vendor-deploy.sh 0.1.0
#        scripts/vendor-deploy.sh /path/to/embeddables/packages/deploy-client
set -euo pipefail

VERSION="${1:?usage: scripts/vendor-deploy.sh <version>}"
if [[ -d "$VERSION" ]]; then
  PACKAGE_SPEC="$(cd "$VERSION" && pwd)"
  SOURCE="@embeddables/deploy@$(node -p 'require(process.argv[1]).version' "$PACKAGE_SPEC/package.json") (local workspace build)"
else
  PACKAGE_SPEC="@embeddables/deploy@${VERSION}"
  SOURCE="$PACKAGE_SPEC"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/embeddables-deploy/vendor/deploy.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

(cd "$WORK" && npm pack --silent "$PACKAGE_SPEC" >/dev/null && tar xzf ./*.tgz)

if grep -E "^import .* from ['\"]" "$WORK/package/dist/index.js" | grep -qvE "from ['\"]node:"; then
  echo "@embeddables/deploy@${VERSION} imports a non-builtin module; it cannot be vendored as one file." >&2
  exit 1
fi

{
  echo "// Vendored from ${SOURCE} by scripts/vendor-deploy.sh. Do not edit by hand."
  grep -v '^//# sourceMappingURL=' "$WORK/package/dist/index.js"
} >"$OUT"

echo "Wrote $OUT from ${SOURCE}"
