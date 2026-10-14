#!/usr/bin/env bash
# Boot one lemma-platform checkout: backend (+ worker, Postgres, Redis,
# SuperTokens) through the product's own scenario harness, then the frontend
# built for production and pointed at it.
#
#   boot/up.sh <checkout> <api_port> <web_port> <out_dir>
#
# Writes <out_dir>/stack.json once BOTH answer, and exits non-zero with the
# reason in <out_dir>/stack.json when either does not. Processes keep running
# in the background; their logs are <out_dir>/backend.log and frontend.log.
set -uo pipefail

CHECKOUT=$(cd "$1" && pwd); API_PORT=$2; WEB_PORT=$3; OUT=$4
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
API="http://localhost:$API_PORT"; WEB="http://localhost:$WEB_PORT"
t0=$(date +%s)

fail() {
  printf '{"state":"failed_to_boot","stage":"%s","reason":%s,"seconds":%s}\n' \
    "$1" "$(printf '%s' "$2" | tail -c 1500 | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$(( $(date +%s) - t0 ))" > "$OUT/stack.json"
  echo "failed_to_boot at $1"; exit 1
}

cd "$CHECKOUT"
SHA=$(git rev-parse HEAD)

log=$( (uv sync --project lemma-backend -q && cd tests/scenarios && uv sync -q) 2>&1 ) || fail python_deps "$log"
log=$( (cd lemma-typescript && npm ci --no-audit --no-fund -q && npm run build -s) 2>&1 ) || fail sdk_build "$log"
log=$( (cd lemma-frontend && npm ci --no-audit --no-fund -q) 2>&1 ) || fail frontend_deps "$log"
t_deps=$(( $(date +%s) - t0 ))

# The backend boots while the frontend builds.
( cd tests/scenarios && LEMMA_RELEASE_SHA=$SHA exec uv run python "$HERE/backend.py" \
    --port "$API_PORT" --frontend "$WEB" --out "$OUT/backend.json" ) > "$OUT/backend.log" 2>&1 &
echo $! > "$OUT/backend.pid"

export NEXT_PUBLIC_DATA=live NEXT_PUBLIC_API_URL=$API NEXT_PUBLIC_SITE_URL=$WEB \
  NEXT_PUBLIC_AUTH_URL=$WEB/auth NEXT_PUBLIC_APPS_DOMAIN_SUFFIX=apps.lemma.localhost \
  NEXT_PUBLIC_AUTH_EMAIL_VERIFICATION_REQUIRED=false NEXT_PUBLIC_LEMMA_DEPLOYMENT=local
# `next build`, not `npm run build`: the npm script also lints and runs design
# checks, which are CI's job, not the workbench's.
log=$( (cd lemma-frontend && npx next build) 2>&1 ) || fail frontend_build "$log"
t_build=$(( $(date +%s) - t0 ))

for _ in $(seq 1 180); do
  [ -f "$OUT/backend.json" ] && break
  kill -0 "$(cat "$OUT/backend.pid")" 2>/dev/null || fail backend "$(tail -60 "$OUT/backend.log")"
  sleep 2
done
[ -f "$OUT/backend.json" ] || fail backend "no /health after 6 minutes: $(tail -40 "$OUT/backend.log")"

( cd lemma-frontend && PORT=$WEB_PORT exec node server.mjs ) > "$OUT/frontend.log" 2>&1 &
echo $! > "$OUT/frontend.pid"
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/auth" || true)
  [ "$code" = 200 ] && break
  sleep 1
done
[ "$code" = 200 ] || fail frontend "GET /auth answered $code: $(tail -40 "$OUT/frontend.log")"

release=$(curl -s "$API/health" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("release") or "")')
[ "$release" = "$SHA" ] || fail health "/health reports release '$release', expected $SHA"

python3 - "$OUT" "$SHA" "$API" "$WEB" "$t_deps" "$t_build" "$(( $(date +%s) - t0 ))" <<'PY'
import json, sys
out, sha, api, web, deps, build, total = sys.argv[1:]
backend = json.load(open(f"{out}/backend.json"))
json.dump({"state": "up", "sha": sha, "api": api, "web": web,
           "seconds": {"deps": int(deps), "frontend_build": int(build), "total": int(total),
                       "backend_boot": backend.get("boot_seconds")},
           "health": backend.get("health")}, open(f"{out}/stack.json", "w"), indent=2)
PY
# One fixed name for the server's own log (API and worker), for the tester to read.
ln -sf "$(python3 -c "import json;print(json.load(open('$OUT/backend.json'))['log_path'])")" "$OUT/server.log"
echo "up: $SHA api=$API web=$WEB in $(( $(date +%s) - t0 ))s"
