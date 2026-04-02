#!/bin/bash
# stop_meeting.sh — остановить запись встречи
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

# Корректная остановка: SIGINT позволяет FFmpeg дописать контейнер
if kill -0 "$PID" 2>/dev/null; then
  echo "Останавливаем FFmpeg (PID $PID)..." >&2
  kill -INT "$PID"
  
  # Ждём завершения (макс 10 сек)
  for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  
  # Если всё ещё жив — принудительно
  if kill -0 "$PID" 2>/dev/null; then
    echo "FFmpeg не завершился, SIGTERM..." >&2
    kill -TERM "$PID" 2>/dev/null || true
    sleep 2
  fi
else
  echo "Предупреждение: FFmpeg (PID $PID) уже не запущен" >&2
fi

# Проверить файл
if [ ! -f "$FILE" ]; then
  echo "{\"error\": \"Файл записи не найден: $FILE\"}" >&2
  rm -f "$STATE_FILE"
  exit 1
fi

FILE_SIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
DURATION_SEC=$(( $(date +%s) - $(date -d "$STARTED_AT" +%s 2>/dev/null || echo $(date +%s)) ))

rm -f "$STATE_FILE"

# Вывод JSON для n8n
cat <<EOF
{
  "file": "$FILE",
  "title": "$TITLE",
  "started_at": "$STARTED_AT",
  "duration_sec": $DURATION_SEC,
  "file_size_bytes": $FILE_SIZE
}
EOF
