#!/bin/bash
# stop_meeting.sh — остановить запись встречи (Puppeteer-бот)
# Вывод: JSON с путём к файлу записи для последующей передачи в transcribe.py

set -euo pipefail

STATE_FILE="/tmp/telemost_meeting.json"

if [ ! -f "$STATE_FILE" ]; then
  echo '{"error": "Нет активной встречи"}' >&2
  exit 1
fi

PID=$(jq -r '.pid' "$STATE_FILE")
FILE=$(jq -r '.file' "$STATE_FILE")
STARTED_AT=$(jq -r '.started_at' "$STATE_FILE")
TITLE=$(jq -r '.title' "$STATE_FILE")

if kill -0 "$PID" 2>/dev/null; then
  echo "Останавливаем recorder (PID $PID)..." >&2
  kill -TERM "$PID"

  for i in $(seq 1 15); do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if kill -0 "$PID" 2>/dev/null; then
    echo "Recorder не завершился, SIGKILL..." >&2
    kill -9 "$PID" 2>/dev/null || true
    sleep 2
  fi
else
  echo "Предупреждение: recorder (PID $PID) уже не запущен" >&2
fi

if [ ! -f "$FILE" ]; then
  echo "{\"error\": \"Файл записи не найден: $FILE\"}" >&2
  rm -f "$STATE_FILE"
  exit 1
fi

FILE_SIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
DURATION_SEC=$(( $(date +%s) - $(date -d "$STARTED_AT" +%s 2>/dev/null || echo $(date +%s)) ))

rm -f "$STATE_FILE"

cat <<EOF
{
  "file": "$FILE",
  "title": "$TITLE",
  "started_at": "$STARTED_AT",
  "duration_sec": $DURATION_SEC,
  "file_size_bytes": $FILE_SIZE
}
EOF
