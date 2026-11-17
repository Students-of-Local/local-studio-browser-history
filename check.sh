#!/bin/bash
# The done check: the same build, lint, type and test pass CI's check job runs.
# It was Polycarp's `browser` check before the move (see README.md, "Moved from Polycarp").
set -euo pipefail
cd "$(dirname "$0")"

# CI runs Node 22. Newer Node changes TLS and path behavior a few CLI tests depend on.
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" = 22 ] || echo "note: Node $major here; CI runs Node 22, and a few CLI tests fail on newer Node" >&2

scripts/setup-siblings.sh
npm ci --no-audit --no-fund
(cd cli && npm ci --no-audit --no-fund)
npx biome check .
npx tsc --noEmit
node scripts/check-theme.mjs
node --import tsx --test test/*.test.mjs
(cd cli && npx tsc --noEmit && npm test)
node cli/dist/index.js skill lint skills
(cd cli && node --test test/skill-lint.test.mjs)
