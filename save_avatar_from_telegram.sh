#!/bin/bash
# Скачивает файл из Telegram по file_id и сохраняет как аватар для лобби Телемоста (JPEG).
# Требуется TELEGRAM_BOT_TOKEN в .env.telemost (тот же токен, что в n8n для бота).
# Использование: ./save_avatar_from_telegram.sh "<file_id>"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FILE_ID="${1:-}"
OUT_FILE="$SCRIPT_DIR/.telemost_bot_avatar.jpg"

set -a
if [ -f "$SCRIPT_DIR/.env.telemost" ]; then
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/.env.telemost"
fi
set +a

if ! command -v jq &>/dev/null; then
  echo '{"error":"jq не найден"}'
  exit 0
fi

if ! command -v curl &>/dev/null; then
  jq -n '{error:"curl не найден"}'
  exit 0
fi

if [ -z "$FILE_ID" ]; then
  jq -n '{error:"Не передан file_id"}'
  exit 0
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  jq -n '{error:"TELEGRAM_BOT_TOKEN не задан в .env.telemost — добавьте токен бота для загрузки фото"}'
  exit 0
fi

ENCODED_FILE_ID="$(printf '%s' "$FILE_ID" | jq -sRr @uri)"
GET_URL="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${ENCODED_FILE_ID}"
set +e
API_RESP="$(curl -sS "$GET_URL")"
curl_getfile_exit=$?
set -e
if [ "$curl_getfile_exit" -ne 0 ]; then
  jq -n '{error:"Не удалось вызвать getFile (сеть или curl)"}'
  exit 0
fi

PATH_ON_SERVER="$(echo "$API_RESP" | jq -r '.result.file_path // empty')"
if [ -z "$PATH_ON_SERVER" ]; then
  DESC="$(echo "$API_RESP" | jq -r '.description // .error_code // "getFile failed"')"
  jq -n --arg d "$DESC" '{error:$d}'
  exit 0
fi

FILE_URL="https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${PATH_ON_SERVER}"
set +e
curl -sS -o "$OUT_FILE" "$FILE_URL"
curl_file_exit=$?
set -e
if [ "$curl_file_exit" -ne 0 ]; then
  rm -f "$OUT_FILE"
  jq -n '{error:"Не удалось скачать файл с серверов Telegram"}'
  exit 0
fi

if [ ! -s "$OUT_FILE" ]; then
  rm -f "$OUT_FILE"
  jq -n '{error:"Получен пустой файл"}'
  exit 0
fi

jq -n --arg p "$OUT_FILE" '{ok:true, avatar_path:$p}'
