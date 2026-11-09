#!/usr/bin/env bash
# Диагностика 403 "Access denied by security policy" от OpenRouter.
#
# Запуск на сервере:
#   bash deploy/diagnose-openrouter.sh 'sk-or-v1-...'
#
# Ключ передаётся аргументом и нигде не сохраняется. Скрипт ничего не меняет:
# это только GET/POST диагностические запросы.
set -uo pipefail

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "usage: $0 'sk-or-v1-...'" >&2
  exit 2
fi

API="https://openrouter.ai/api/v1"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

section() { printf '\n=== %s ===\n' "$1"; }

# Печатает HTTP-код, оставляя тело ответа в $BODY.
probe() {
  curl -sS -o "$BODY" -w '%{http_code}' --max-time 30 "$@"
}

chat() { # $1 = url-encoded extra header (может быть пустым)
  local -a extra=()
  [ -n "${1:-}" ] && extra=(-H "$1")
  probe -X POST "$API/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' \
    -H 'X-Title: Instalead' \
    "${extra[@]}" \
    -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
}

printf 'OpenRouter diagnostics — %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

section "1. Exit IP and geo"
curl -sS --max-time 15 https://ipinfo.io/json 2>/dev/null | head -c 400
echo

section "2. DNS"
getent hosts openrouter.ai || echo "DNS resolution failed"

section "3. Unauthenticated GET /models (does the edge answer this IP at all?)"
S3="$(probe "$API/models")"
echo "status=$S3"

section "4. GET /auth/key (is the key itself accepted from this IP?)"
S4="$(probe "$API/auth/key" -H "Authorization: Bearer $KEY")"
echo "status=$S4"
head -c 300 "$BODY"; echo

section "5. POST /chat/completions, real model, no extra headers"
S5="$(chat)"
echo "status=$S5"
head -c 300 "$BODY"; echo

section "6. POST /chat/completions with HTTP-Referer (if OPENROUTER_SITE_URL is set)"
S6="$(chat "HTTP-Referer: ${OPENROUTER_SITE_URL:-http://localhost:5173}")"
echo "status=$S6"
head -c 300 "$BODY"; echo

section "7. POST /chat/completions with a nonexistent model (post-auth or pre-auth block?)"
S7="$(probe -X POST "$API/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"nonexistent-vendor/nonexistent-model","messages":[{"role":"user","content":"hi"}],"max_tokens":5}')"
echo "status=$S7"
head -c 300 "$BODY"; echo

section "VERDICT"
if [ "$S4" = "200" ]; then
  echo "Key accepted from this IP (/auth/key returned 200)."
  if [ "$S5" = "200" ]; then
    echo "RESULT: everything works from this host."
  else
    echo "RESULT: key is valid but chat/completions is denied -> block is NOT auth-related."
    echo "Most likely: this host's egress IP/geo is filtered by OpenRouter's edge policy."
    echo "Same key + same model from another network should be tested to confirm."
  fi
elif [ "$S4" = "401" ]; then
  echo "RESULT: this key is invalid on THIS server."
  echo "The server stores its own key in /var/lib/instalead/data/*.db (or backend/data)."
  echo "It may differ from the key in your local database."
elif [ "$S4" = "403" ]; then
  echo "RESULT: blocked before auth resolution (/auth/key returns 403 with a valid key)."
  echo "The request is denied at the edge on IP/geo grounds, not by account settings."
else
  echo "RESULT: unexpected status from /auth/key ($S4) — inspect the body above."
fi