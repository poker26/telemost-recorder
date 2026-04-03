-- Supabase: таблица для хранения транскриптов встреч
CREATE TABLE IF NOT EXISTS meeting_transcripts (
    id              BIGSERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    file_path       TEXT,
    transcript      TEXT,
    utterances      JSONB,          -- массив {speaker, text, start_ms, end_ms}
    speaker_count   INTEGER,
    transcribed_at  TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_meeting_transcripts_created ON meeting_transcripts(created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- ИНСТРУКЦИЯ ПО УСТАНОВКЕ
-- ─────────────────────────────────────────────────────────────

-- 1. ЗАВИСИМОСТИ НА СЕРВЕРЕ
--
--    apt install ffmpeg python3-venv jq -y
--    cd /opt/telemost-recorder
--    python3 -m venv .venv
--    ./.venv/bin/pip install boto3 requests
--    mkdir -p /opt/recordings/telemost
--    chmod +x start_meeting.sh stop_meeting.sh

-- 2. ПРОЕКТНЫЙ ФАЙЛ СЕКРЕТОВ НА СЕРВЕРЕ
--
--    cp /opt/telemost-recorder/.env.telemost.example /opt/telemost-recorder/.env.telemost
--    nano /opt/telemost-recorder/.env.telemost
--    chmod 600 /opt/telemost-recorder/.env.telemost
--
--    В файле:
--      TELEMOST_TOKEN=...
--      YC_FOLDER_ID=...
--      YC_API_KEY=...             (роль: ai.speechkit.user)
--      YC_S3_BUCKET=...           (бакет YC Object Storage, временный)
--      YC_S3_KEY_ID=...           (статический ключ YC)
--      YC_S3_SECRET=...           (секрет YC)
--      MINIO_ENDPOINT=https://s3.begemot26.ru
--      MINIO_ACCESS_KEY=...
--      MINIO_SECRET_KEY=...
--      MINIO_USE_SSL=true
--      MINIO_BUCKET_MEDIA=telemost
--
--    Dual-upload: аудио загружается в MinIO (долгосрочно)
--    и во временный бакет YC Object Storage (для SpeechKit).
--    После транскрибации временная копия удаляется из YC.

-- 3. ПОЛУЧЕНИЕ TELEMOST_TOKEN
--    - Перейти: oauth.yandex.ru/client/new
--    - Платформа: Веб-сервисы
--    - Права: telemost-api:conferences.create, conferences.read
--    - Получить OAuth-токен через authorize URL

-- 4. ПОЛУЧЕНИЕ YC_API_KEY + СТАТИЧЕСКИЙ КЛЮЧ S3
--    - Создать сервисный аккаунт в Яндекс Облаке
--    - Назначить роли: ai.speechkit.user + storage.uploader
--    - Создать API-ключ (для SpeechKit)
--    - Создать статический ключ (для Object Storage) → YC_S3_KEY_ID + YC_S3_SECRET

-- 5. ПРОВЕРКА ЗАПИСИ (вручную)
--    set -a; . /opt/telemost-recorder/.env.telemost; set +a
--    bash /opt/telemost-recorder/start_meeting.sh "Тест"
--    # → получить join_url, зайти в конфу
--    sleep 30
--    bash /opt/telemost-recorder/stop_meeting.sh

-- 6. ПРОВЕРКА ТРАНСКРИБАЦИИ
--    set -a; . /opt/telemost-recorder/.env.telemost; set +a
--    /opt/telemost-recorder/.venv/bin/python /opt/telemost-recorder/transcribe.py /tmp/test.ogg "Тест"
