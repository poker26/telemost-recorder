#!/bin/bash
# join_meeting.sh — запись встречи по присланной ссылке Телемоста (без создания конференции через API)
# Использование: ./join_meeting.sh "https://telemost.yandex.ru/j/..." "Название" [telegram_chat_id]
# Env: RECORDINGS_DIR (опционально). TELEMOST_TOKEN не требуется.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JOIN_URL="${1:-}"
TITLE="${2:-Встреча по ссылке $(TZ=Europe/Moscow date '+%d.%m.%Y %H:%M')}"
TELEGRAM_CHAT_ID_ARG="${3:-}"
STATE_FILE="/tmp/telemost_meeting.json"
RECORDINGS_DIR="${RECORDINGS_DIR:-/opt/recordings/telemost}"
LOG_FILE="/tmp/telemost_recorder.log"

if [ -f "$STATE_FILE" ]; then
  echo '{"error":"Встреча уже идёт. Сначала выполните /meeting_stop"}' >&2
  exit 1
fi

if [ -z "$JOIN_URL" ]; then
  echo '{"error":"Не указана ссылка на встречу"}' >&2
  exit 1
fi

if ! echo "$JOIN_URL" | grep -qE '/j/[^/[:space:]]+'; then
  echo '{"error":"Ожидается ссылка Телемоста вида https://telemost.yandex.ru/j/..."}' >&2
  exit 1
fi

for cmd in jq node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "{\"error\":\"$cmd не найден\"}" >&2
    exit 1
  fi
done

PROFILE_JSON="$SCRIPT_DIR/telemost_recorder_profile.json"
if [ -f "$PROFILE_JSON" ]; then
  DISPLAY_OVERRIDE="$(jq -r '.display_name // empty' "$PROFILE_JSON")"
  if [ -n "$DISPLAY_OVERRIDE" ]; then
    export BOT_DISPLAY_NAME="$DISPLAY_OVERRIDE"
  fi
  AVATAR_OVERRIDE="$(jq -r '.avatar_path // empty' "$PROFILE_JSON")"
  if [ -n "$AVATAR_OVERRIDE" ] && [ -f "$AVATAR_OVERRIDE" ]; then
    export BOT_LOBBY_AVATAR_PATH="$AVATAR_OVERRIDE"
  fi
fi

mkdir -p "$RECORDINGS_DIR"

CONFERENCE_ID="$(echo "$JOIN_URL" | sed -n 's|.*\/j\/\([^/?#]*\).*|\1|p')"
if [ -z "$CONFERENCE_ID" ]; then
  CONFERENCE_ID="external"
fi

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
OUTPUT_FILE="$RECORDINGS_DIR/meeting_${TIMESTAMP}.webm"

echo "Подключаемся по ссылке, запись: $OUTPUT_FILE" >&2

node "$SCRIPT_DIR/recorder.js" "$JOIN_URL" "$OUTPUT_FILE" \
  </dev/null >"$LOG_FILE" 2>&1 &

RECORDER_PID=$!

sleep 8
if ! kill -0 "$RECORDER_PID" 2>/dev/null; then
  echo '{"error":"Recorder завершился сразу после старта (см. /tmp/telemost_recorder.log на сервере)"}' >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

STARTED_AT="$(TZ=Europe/Moscow date -Iseconds)"

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
