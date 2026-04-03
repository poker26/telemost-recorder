#!/bin/bash
# start_meeting.sh — создать конференцию Телемост и запустить запись
# Использование: ./start_meeting.sh "Название встречи"
# Env: TELEMOST_TOKEN, RECORDINGS_DIR (опционально)

set -euo pipefail

TITLE="${1:-Встреча $(date '+%d.%m.%Y %H:%M')}"
STATE_FILE="/tmp/telemost_meeting.json"
RECORDINGS_DIR="${RECORDINGS_DIR:-/opt/recordings/telemost}"
LOG_FILE="/tmp/telemost_ffmpeg.log"

# Проверить: нет ли уже активной встречи
if [ -f "$STATE_FILE" ]; then
  echo "ERROR: Встреча уже идёт. Сначала выполните /meeting_stop" >&2
  exit 1
fi

# Проверить наличие зависимостей
for cmd in curl jq ffmpeg; do
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

# Создать конференцию через API
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
WATCH_URL=$(echo "$BODY" | jq -r '.live_stream.watch_url')

if [ -z "$WATCH_URL" ] || [ "$WATCH_URL" = "null" ]; then
  echo "ERROR: watch_url не получен. Ответ API: $BODY" >&2
  exit 1
fi

# Путь к файлу записи
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
OUTPUT_FILE="$RECORDINGS_DIR/meeting_${TIMESTAMP}.ogg"

# Запустить FFmpeg в фоне
# -reconnect* — на случай кратких обрывов HLS-потока
ffmpeg \
  -reconnect 1 \
  -reconnect_at_eof 1 \
  -reconnect_streamed 1 \
  -reconnect_delay_max 30 \
  -i "$WATCH_URL" \
  -vn \
  -ac 1 \
  -ar 16000 \
  -c:a libopus \
  -b:a 32k \
  "$OUTPUT_FILE" \
  </dev/null >"$LOG_FILE" 2>&1 &

FFMPEG_PID=$!

# Подождать 3 секунды — убедиться, что ffmpeg не упал сразу
sleep 3
if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
  echo "ERROR: FFmpeg завершился сразу после старта. Лог:" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

# Сохранить состояние
cat > "$STATE_FILE" <<EOF
{
  "pid": $FFMPEG_PID,
  "file": "$OUTPUT_FILE",
  "conference_id": "$CONFERENCE_ID",
  "join_url": "$JOIN_URL",
  "watch_url": "$WATCH_URL",
  "title": "$TITLE",
  "started_at": "$(date -Iseconds)"
}
EOF

# Вывод для n8n (JSON)
echo "$STATE_FILE" | xargs cat
