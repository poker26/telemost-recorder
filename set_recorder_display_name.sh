#!/bin/bash
# Сохраняет отображаемое имя бота в лобби Телемоста (перекрывает BOT_DISPLAY_NAME из .env).
# Использование: ./set_recorder_display_name.sh "Имя участника"
# Сброс к значению из .env: ./set_recorder_display_name.sh --reset

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_JSON="$SCRIPT_DIR/telemost_recorder_profile.json"
NAME_RAW="${1:-}"

if ! command -v jq &>/dev/null; then
  echo '{"error":"jq не найден"}'
  exit 0
fi

if [ "$NAME_RAW" = "--reset" ] || [ "$NAME_RAW" = "-" ]; then
  if [ -f "$PROFILE_JSON" ]; then
    tmp_merge="$(mktemp)"
    jq 'del(.display_name)' "$PROFILE_JSON" >"$tmp_merge"
    mv "$tmp_merge" "$PROFILE_JSON"
  fi
  jq -n '{ok:true, message:"Имя в профиле сброшено — при записи используется BOT_DISPLAY_NAME из .env.telemost"}'
  exit 0
fi

NAME_TRIMMED="$(echo -n "$NAME_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
if [ -z "$NAME_TRIMMED" ]; then
  jq -n '{error:"Укажите имя после команды, например: /telemost_name EN Recorder"}'
  exit 0
fi

if [ "${#NAME_TRIMMED}" -gt 128 ]; then
  jq -n '{error:"Слишком длинное имя (макс. 128 символов)"}'
  exit 0
fi

tmp_merge="$(mktemp)"
if [ -f "$PROFILE_JSON" ]; then
  jq --arg n "$NAME_TRIMMED" '.display_name = $n' "$PROFILE_JSON" >"$tmp_merge"
else
  jq -n --arg n "$NAME_TRIMMED" '{display_name: $n}' >"$tmp_merge"
fi
mv "$tmp_merge" "$PROFILE_JSON"

jq -n --arg n "$NAME_TRIMMED" '{ok:true, display_name:$n}'
