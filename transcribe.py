#!/usr/bin/env python3
"""
transcribe.py — загрузить .ogg в MinIO (долгосрочно) и YC Object Storage
(временно для SpeechKit), транскрибировать через Yandex SpeechKit,
вернуть JSON с текстом и метаданными.

Использование:
  python3 transcribe.py /path/to/meeting.ogg "Название встречи"

Env:
  YC_FOLDER_ID       — ID папки в Яндекс Облаке
  YC_API_KEY         — API-ключ сервисного аккаунта (предпочтительно)
  YC_IAM_TOKEN       — или IAM-токен (истекает через 12 часов)
  YC_S3_BUCKET       — бакет в Yandex Object Storage (временный, для SpeechKit)
  YC_S3_KEY_ID       — статический ключ доступа YC Object Storage
  YC_S3_SECRET       — секрет YC Object Storage
  MINIO_ENDPOINT     — endpoint MinIO, например https://s3.begemot26.ru
  MINIO_ACCESS_KEY   — ключ доступа MinIO
  MINIO_SECRET_KEY   — секрет MinIO
  MINIO_USE_SSL      — true/false (если endpoint без схемы)
  MINIO_BUCKET_MEDIA — имя бакета MinIO для аудиофайлов
"""

import sys
import os
import json
import time
import subprocess
import boto3
import requests
from botocore.config import Config
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

# ── Конфигурация ──────────────────────────────────────────────────────────────

FOLDER_ID = os.environ["YC_FOLDER_ID"]

MINIO_ENDPOINT = os.environ["MINIO_ENDPOINT"].strip()
MINIO_ACCESS_KEY = os.environ["MINIO_ACCESS_KEY"]
MINIO_SECRET_KEY = os.environ["MINIO_SECRET_KEY"]
MINIO_BUCKET_MEDIA = os.environ["MINIO_BUCKET_MEDIA"]
MINIO_USE_SSL = os.environ.get("MINIO_USE_SSL", "true").strip().lower() in {
    "1", "true", "yes", "on",
}

YC_S3_BUCKET = os.environ["YC_S3_BUCKET"]
YC_S3_KEY_ID = os.environ["YC_S3_KEY_ID"]
YC_S3_SECRET = os.environ["YC_S3_SECRET"]

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


# ── MinIO (долгосрочное хранение) ─────────────────────────────────────────────

def build_minio_base_url() -> str:
    if MINIO_ENDPOINT.startswith("http://") or MINIO_ENDPOINT.startswith("https://"):
        return MINIO_ENDPOINT.rstrip("/")
    scheme = "https" if MINIO_USE_SSL else "http"
    return f"{scheme}://{MINIO_ENDPOINT.rstrip('/')}"


def upload_to_minio(file_path: str) -> str:
    """Загрузить файл в MinIO для долгосрочного хранения."""
    minio_base_url = build_minio_base_url()
    client = boto3.client(
        "s3",
        endpoint_url=minio_base_url,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),
    )
    object_name = f"telemost-recordings/{Path(file_path).name}"

    print(
        f"[MinIO] Загрузка {file_path} → {MINIO_BUCKET_MEDIA}/{object_name}",
        file=sys.stderr,
    )
    client.upload_file(file_path, MINIO_BUCKET_MEDIA, object_name)
    return f"{minio_base_url}/{MINIO_BUCKET_MEDIA}/{object_name}"


# ── YC Object Storage (временное хранение для SpeechKit) ──────────────────────

def _yc_s3_client():
    return boto3.client(
        "s3",
        endpoint_url="https://storage.yandexcloud.net",
        aws_access_key_id=YC_S3_KEY_ID,
        aws_secret_access_key=YC_S3_SECRET,
        region_name="ru-central1",
    )


def upload_to_yc(file_path: str) -> tuple[str, str]:
    """Загрузить файл в YC Object Storage, вернуть (public_url, object_name)."""
    client = _yc_s3_client()
    object_name = f"telemost-tmp/{Path(file_path).name}"

    print(
        f"[YC S3] Загрузка {file_path} → {YC_S3_BUCKET}/{object_name}",
        file=sys.stderr,
    )
    client.upload_file(file_path, YC_S3_BUCKET, object_name)
    public_url = f"https://storage.yandexcloud.net/{YC_S3_BUCKET}/{object_name}"
    return public_url, object_name


def delete_from_yc(object_name: str) -> None:
    """Удалить временный файл из YC Object Storage."""
    try:
        client = _yc_s3_client()
        client.delete_object(Bucket=YC_S3_BUCKET, Key=object_name)
        print(f"[YC S3] Удалён {YC_S3_BUCKET}/{object_name}", file=sys.stderr)
    except Exception as exc:
        print(
            f"[YC S3] Не удалось удалить {object_name}: {exc}",
            file=sys.stderr,
        )


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
                "enableSpeakerLabeling": True,
                "rawResults": False,
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
    if not resp.ok:
        print(f"SpeechKit HTTP {resp.status_code}: {resp.text}", file=sys.stderr)
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
        except requests.RequestException as exc:
            print(f"Attempt {attempt}: ошибка запроса: {exc}", file=sys.stderr)
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

        if speaker != prev_speaker:
            lines.append(f"\n[Спикер {speaker}]")
            prev_speaker = speaker
        lines.append(text)

    return "\n".join(lines).strip(), utterances


# ── Точка входа ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Использование: transcribe.py <file.webm|file.ogg> [title]", file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[1]
    title = sys.argv[2] if len(sys.argv) > 2 else Path(file_path).stem

    if not Path(file_path).exists():
        print(f"ERROR: файл не найден: {file_path}", file=sys.stderr)
        sys.exit(1)

    file_size_bytes = Path(file_path).stat().st_size
    if file_size_bytes == 0:
        print(
            "ERROR: файл записи пуст (0 байт). Запись не успела накопиться или бот упал.",
            file=sys.stderr,
        )
        sys.exit(1)

    audio_for_speechkit = file_path
    if file_path.endswith(".webm"):
        audio_for_speechkit = file_path.rsplit(".", 1)[0] + ".ogg"
        print(f"Конвертация {file_path} → {audio_for_speechkit}", file=sys.stderr)
        ffmpeg_result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                file_path,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "libopus",
                "-b:a",
                "32k",
                audio_for_speechkit,
            ],
            capture_output=True,
            text=True,
        )
        if ffmpeg_result.returncode != 0:
            print(
                f"ERROR: ffmpeg код {ffmpeg_result.returncode}",
                file=sys.stderr,
            )
            print(ffmpeg_result.stderr or ffmpeg_result.stdout or "", file=sys.stderr)
            sys.exit(1)

    upload_to_minio(file_path)

    yc_audio_url, yc_object_name = upload_to_yc(audio_for_speechkit)
    op_id = start_recognition(yc_audio_url)

    print("Ожидаем результатов SpeechKit...", file=sys.stderr)
    result = poll_results(op_id)

    delete_from_yc(yc_object_name)

    transcript_text, utterances = format_transcript(result)

    output = {
        "title": title,
        "file_path": file_path,
        "operation_id": op_id,
        "transcribed_at": datetime.now(ZoneInfo("Europe/Moscow")).isoformat(),
        "transcript": transcript_text,
        "utterances": utterances,
        "utterance_count": len(utterances),
        "speaker_count": len({u["speaker"] for u in utterances}),
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
