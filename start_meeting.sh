#!/bin/bash
# start_meeting.sh — создать конференцию Телемост и запустить запись через Puppeteer-бота
# Использование: ./start_meeting.sh "Название встречи" [telegram_chat_id]
# Второй аргумент (числовой id чата) сохраняется в state для webhook при автофинишe в Телемосте.
# Env: TELEMOST_TOKEN, RECORDINGS_DIR (опционально)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TITLE="${1:-Встреча $(date '+%d.%m.%Y %H:%M')}"
TELEGRAM_CHAT_ID_ARG="${2:-}"
STATE_FILE="/tmp/telemost_meeting.json"
RECORDINGS_DIR="${RECORDINGS_DIR:-/opt/recordings/telemost}"
LOG_FILE="/tmp/telemost_recorder.log"

if [ -f "$STATE_FILE" ]; then
  echo "ERROR: Встреча уже идёт. Сначала выполните /meeting_stop" >&2
  exit 1
fi

for cmd in curl jq node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd не найден" >&2
    exit 1
  fi
done

if [ -z "${TELEMOST_TOKEN:-}" ]; then
  echo "ERROR: Переменная TELEMOST_TOKEN не задана" >&2
  exit 1
fi

mkdir -p "$RECORDINGS_DIR"

echo "Создаём конференцию: $TITLE" >&2
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "https://cloud-api.yandex.net/v1/telemost-api/conferences" \
  -H "Authorization: OAuth $TELEMOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"waiting_room_level\": \"ADMINS\",
    \"live_stream\": {
      \"access_level\": \"PUBLIC\",
      \"title\": \"$TITLE\"
    }
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" != "201" ]; then
  echo "ERROR: Telemost API вернул $HTTP_CODE: $BODY" >&2
  exit 1
fi

CONFERENCE_ID=$(echo "$BODY" | jq -r '.id')
JOIN_URL=$(echo "$BODY" | jq -r '.join_url')

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
OUTPUT_FILE="$RECORDINGS_DIR/meeting_${TIMESTAMP}.webm"

node "$SCRIPT_DIR/recorder.js" "$JOIN_URL" "$OUTPUT_FILE" \
  </dev/null >"$LOG_FILE" 2>&1 &

RECORDER_PID=$!

sleep 8
if ! kill -0 "$RECORDER_PID" 2>/dev/null; then
  echo "ERROR: Recorder завершился сразу после старта. Лог:" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

STARTED_AT="$(date -Iseconds)"

BASE_JSON=$(jq -n \
  --argjson pid "$RECORDER_PID" \
  --arg file "$OUTPUT_FILE" \
  --arg conference_id "$CONFERENCE_ID" \
  --arg join_url "$JOIN_URL" \
  --arg title "$TITLE" \
  --arg started_at "$STARTED_AT" \
  '{
    pid: $pid,
    file: $file,
    conference_id: $conference_id,
    join_url: $join_url,
    title: $title,
    started_at: $started_at
  }')

if [ -n "$TELEGRAM_CHAT_ID_ARG" ] && [[ "$TELEGRAM_CHAT_ID_ARG" =~ ^-?[0-9]+$ ]]; then
  echo "$BASE_JSON" | jq --argjson telegram_chat_id "$TELEGRAM_CHAT_ID_ARG" '. + {telegram_chat_id: $telegram_chat_id}' >"$STATE_FILE"
else
  echo "$BASE_JSON" >"$STATE_FILE"
fi

echo "$STATE_FILE" | xargs cat
