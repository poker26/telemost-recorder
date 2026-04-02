#!/usr/bin/env python3
"""
transcribe.py — загрузить .ogg в S3, транскрибировать через Yandex SpeechKit,
вернуть JSON с текстом и метаданными.

Использование:
  python3 transcribe.py /path/to/meeting.ogg "Название встречи"

Env:
  YC_FOLDER_ID      — ID папки в Яндекс Облаке
  YC_API_KEY        — API-ключ сервисного аккаунта (предпочтительно)
  YC_IAM_TOKEN      — или IAM-токен (истекает через 12 часов)
  YC_S3_BUCKET      — имя бакета в Object Storage
  YC_S3_KEY_ID      — ключ доступа S3
  YC_S3_SECRET      — секрет S3
"""

import sys
import os
import json
import time
import boto3
import requests
from pathlib import Path
from datetime import datetime

# ── Конфигурация ──────────────────────────────────────────────────────────────

FOLDER_ID  = os.environ["YC_FOLDER_ID"]
S3_BUCKET  = os.environ["YC_S3_BUCKET"]
S3_KEY_ID  = os.environ["YC_S3_KEY_ID"]
S3_SECRET  = os.environ["YC_S3_SECRET"]

# Поддерживаем оба варианта авторизации
if os.environ.get("YC_API_KEY"):
    AUTH_HEADER = f"Api-Key {os.environ['YC_API_KEY']}"
elif os.environ.get("YC_IAM_TOKEN"):
    AUTH_HEADER = f"Bearer {os.environ['YC_IAM_TOKEN']}"
else:
    raise EnvironmentError("Нужен YC_API_KEY или YC_IAM_TOKEN")

SPEECHKIT_START_URL = (
    "https://transcribe.api.cloud.yandex.net/speech/stt/v2/longRunningRecognize"
)
OPERATIONS_URL = "https://operation.api.cloud.yandex.net/operations"


# ── S3 upload ─────────────────────────────────────────────────────────────────

def upload_to_s3(file_path: str) -> str:
    """Загрузить файл в Yandex Object Storage, вернуть публичный URL."""
    s3 = boto3.client(
        "s3",
        endpoint_url="https://storage.yandexcloud.net",
        aws_access_key_id=S3_KEY_ID,
        aws_secret_access_key=S3_SECRET,
        region_name="ru-central1",
    )
    object_name = f"telemost-recordings/{Path(file_path).name}"
    
    print(f"Загрузка {file_path} → s3://{S3_BUCKET}/{object_name}", file=sys.stderr)
    s3.upload_file(
        file_path,
        S3_BUCKET,
        object_name,
        ExtraArgs={"StorageClass": "STANDARD"},
    )
    return f"https://storage.yandexcloud.net/{S3_BUCKET}/{object_name}"


# ── SpeechKit ─────────────────────────────────────────────────────────────────

def start_recognition(audio_url: str) -> str:
    """Запустить асинхронное распознавание, вернуть operation ID."""
    payload = {
        "config": {
            "specification": {
                "languageCode": "ru-RU",
                "model": "general",
                "audioEncoding": "OGG_OPUS",
                "audioChannelCount": 1,
                "enableSpeakerLabeling": True,   # диаризация спикеров
                "rawResults": False,              # с пунктуацией
                "profanityFilter": False,
            },
            "folderId": FOLDER_ID,
        },
        "audio": {"uri": audio_url},
    }

    resp = requests.post(
        SPEECHKIT_START_URL,
        json=payload,
        headers={"Authorization": AUTH_HEADER},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()

    op_id = data.get("id")
    if not op_id:
        raise RuntimeError(f"Не получен operation ID: {data}")
    
    print(f"Operation ID: {op_id}", file=sys.stderr)
    return op_id


def poll_results(operation_id: str, max_wait_sec: int = 7200) -> dict:
    """
    Опрашивать статус операции до завершения.
    SpeechKit: ~10 сек на 1 мин аудио.
    """
    url = f"{OPERATIONS_URL}/{operation_id}"
    headers = {"Authorization": AUTH_HEADER}
    
    start = time.time()
    attempt = 0
    
    while time.time() - start < max_wait_sec:
        attempt += 1
        try:
            resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            print(f"Attempt {attempt}: ошибка запроса: {e}", file=sys.stderr)
            time.sleep(15)
            continue

        if data.get("done"):
            if "error" in data:
                raise RuntimeError(f"SpeechKit error: {data['error']}")
            return data.get("response", {})

        elapsed = int(time.time() - start)
        print(f"Attempt {attempt}: ещё не готово ({elapsed}s)...", file=sys.stderr)
        time.sleep(15)

    raise TimeoutError(f"Распознавание не завершилось за {max_wait_sec}s")


# ── Форматирование ────────────────────────────────────────────────────────────

def format_transcript(response: dict) -> tuple[str, list[dict]]:
    """
    Вернуть (текст_с_метками, список_реплик).
    Каждая реплика: {speaker, text, start_ms, end_ms}
    """
    chunks = response.get("chunks", [])
    lines = []
    utterances = []
    prev_speaker = None

    for chunk in chunks:
        alternatives = chunk.get("alternatives", [])
        if not alternatives:
            continue

        best = alternatives[0]
        text = best.get("text", "").strip()
        if not text:
            continue

        words = best.get("words", [])
        speaker = words[0].get("speakerTag", "?") if words else "?"

        # Временны́е метки из слов
        start_ms = None
        end_ms = None
        if words:
            try:
                start_ms = int(float(words[0].get("startTime", "0").rstrip("s")) * 1000)
                end_ms   = int(float(words[-1].get("endTime", "0").rstrip("s")) * 1000)
            except (ValueError, AttributeError):
                pass

        utterances.append({
            "speaker": speaker,
            "text": text,
            "start_ms": start_ms,
            "end_ms": end_ms,
        })

        # Форматированный текст: новый заголовок при смене спикера
        if speaker != prev_speaker:
            lines.append(f"\n[Спикер {speaker}]")
            prev_speaker = speaker
        lines.append(text)

    return "\n".join(lines).strip(), utterances


# ── Точка входа ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Использование: transcribe.py <file.ogg> [title]", file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]
    title = sys.argv[2] if len(sys.argv) > 2 else Path(file_path).stem

    if not Path(file_path).exists():
        print(f"ERROR: файл не найден: {file_path}", file=sys.stderr)
        sys.exit(1)

    # Пайплайн
    audio_url = upload_to_s3(file_path)
    op_id = start_recognition(audio_url)

    print("Ожидаем результатов SpeechKit...", file=sys.stderr)
    result = poll_results(op_id)

    transcript_text, utterances = format_transcript(result)

    output = {
        "title": title,
        "file": file_path,
        "operation_id": op_id,
        "transcribed_at": datetime.now().isoformat(),
        "transcript": transcript_text,
        "utterances": utterances,
        "utterance_count": len(utterances),
        "speaker_count": len({u["speaker"] for u in utterances}),
    }

    # Stdout — для n8n (Parse JSON node)
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
