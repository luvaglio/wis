#!/usr/bin/env bash
#
# Point a Telegram bot at this Worker (SPEC 4).
#
# Telegram is pull-to-push: the bot token is what authorises registration, and
# Telegram then POSTs updates to the URL you register. The secret token is sent
# back on every request as X-Telegram-Bot-Api-Secret-Token, which is how the
# Worker knows an update genuinely came from Telegram.
#
# Usage:
#   read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
#   read -rs TELEGRAM_WEBHOOK_SECRET && export TELEGRAM_WEBHOOK_SECRET
#   ./scripts/register-telegram-webhook.sh
#
# Reading with `read -rs` keeps both values out of your shell history.

set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?export TELEGRAM_BOT_TOKEN first}"
: "${TELEGRAM_WEBHOOK_SECRET:?export TELEGRAM_WEBHOOK_SECRET first}"

ORIGIN="${PUBLIC_ORIGIN:-https://wis.ai}"
URL="${ORIGIN}/webhooks/telegram"

echo "Registering ${URL}"

curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{
  "url": "${URL}",
  "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ["message"],
  "drop_pending_updates": true
}
JSON
)" | python3 -m json.tool

echo
echo "Current webhook state:"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["result"]; [print(f"  {k}: {v}") for k,v in d.items() if k != "url" or True]'
