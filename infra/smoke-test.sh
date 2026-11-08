#!/usr/bin/env sh
# Smoke test against a running stack (used in CI and after updates).
#   BASE_URL=https://localhost:8443 infra/smoke-test.sh
set -eu

BASE_URL="${BASE_URL:-https://localhost}"
CURL="curl -fsSk --max-time 10"

check() {
  name="$1"; path="$2"; expect="$3"
  body=$($CURL "$BASE_URL$path") || { echo "FAIL $name: request failed"; exit 1; }
  case "$body" in
    *"$expect"*) echo "ok   $name" ;;
    *) echo "FAIL $name: expected '$expect', got: $body"; exit 1 ;;
  esac
}

# Wait until the proxy has its certificate and the app answers (max. 60 s).
i=0
until $CURL "$BASE_URL/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 30 ] && { echo "FAIL stack did not become reachable at $BASE_URL"; exit 1; }
  sleep 2
done

check "liveness"        /healthz      '"status":"ok"'
check "readiness (db)"  /readyz       '"status":"ready"'
check "api metadata"    /api/v1/meta  '"name"'
check "web app"         /             '<div id="root">'

headers=$($CURL -I "$BASE_URL/")
echo "$headers" | grep -qi '^strict-transport-security:' || { echo "FAIL security headers: HSTS missing"; exit 1; }
echo "$headers" | grep -qi '^content-security-policy:' || { echo "FAIL security headers: CSP missing"; exit 1; }
echo "ok   security headers"

status=$(curl -sk -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/does-not-exist")
[ "$status" = "404" ] || { echo "FAIL unknown route: expected 404, got $status"; exit 1; }
echo "ok   problem details for unknown routes"

echo "Smoke test passed."
