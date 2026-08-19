#!/usr/bin/env bash
#
# Point a Telegram bot at this Worker (SPEC 4).
#
# Telegram is pull-to-push: the bot token authorises registration, and Telegram
# then POSTs updates to the URL you register. The secret token is echoed back on
# every request as X-Telegram-Bot-Api-Secret-Token, which is how the Worker
# knows an update genuinely came from Telegram.
#
# Usage:
#   read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
#   read -rs TELEGRAM_WEBHOOK_SECRET && export TELEGRAM_WEBHOOK_SECRET
#   ./scripts/register-telegram-webhook.sh
#
# Reading with `read -rs` keeps both values out of your shell history.
#
# The secret must be byte-identical to the one the Worker holds:
#   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# If they differ, Telegram delivers and the Worker rejects every update, and
# the only symptom is that nothing happens.

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?export TELEGRAM_BOT_TOKEN first}"
: "${TELEGRAM_WEBHOOK_SECRET:?export TELEGRAM_WEBHOOK_SECRET first}"

ORIGIN="${PUBLIC_ORIGIN:-https://wis.ai}"
URL="${ORIGIN}/webhooks/telegram"

api () {
  curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/$1" "${@:2}"
}

# Report Telegram's own error rather than failing on a missing "result" key,
# which is what a bad token used to produce.
show () {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  could not parse Telegram response")
    sys.exit(1)
if not d.get("ok"):
    code = d.get("error_code", "")
    desc = d.get("description", "unknown error")
    print("  FAILED " + str(code) + ": " + str(desc))
    sys.exit(1)
r = d.get("result")
if isinstance(r, dict):
    for k, v in r.items():
        print("  " + str(k) + ": " + str(v))
else:
    print("  " + str(r))
'
}

echo "1. Checking the bot token"
api getMe | show || {
  echo
  echo "The token is not valid. Copy it again from @BotFather."
  exit 1
}

echo
echo "2. Registering ${URL}"
api setWebhook -H 'content-type: application/json' -d "$(cat <<JSON
{
  "url": "${URL}",
  "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ["message"],
  "drop_pending_updates": true
}
JSON
)" | show || exit 1

echo
echo "3. Reading the registration back"
api getWebhookInfo | show || exit 1

echo
echo "Done. Send the bot a message, then check:"
echo "  curl -sS -b <your session cookie> ${ORIGIN}/api/diagnostics"
echo
echo "If 'url' above is empty, registration did not take."
echo "If 'last_error_message' mentions 403, the secret does not match the Worker's."
