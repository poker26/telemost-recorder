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

-- 1. УСТАНОВКА НА 46.173.25.31
--
--    apt install ffmpeg python3-pip jq -y
--    pip3 install boto3 requests
--
--    mkdir -p /opt/telemost /opt/recordings/telemost
--    cp start_meeting.sh stop_meeting.sh /opt/telemost/
--    cp transcribe.py /opt/telemost/
--    chmod +x /opt/telemost/*.sh

-- 2. ПРОЕКТНЫЙ ФАЙЛ СЕКРЕТОВ НА СЕРВЕРЕ
--
--    cp /opt/telemost-recorder/.env.telemost.example /opt/telemost-recorder/.env.telemost
--    nano /opt/telemost-recorder/.env.telemost
--    chmod 600 /opt/telemost-recorder/.env.telemost
--
--    В файле:
--      TELEMOST_TOKEN=...
--      YC_FOLDER_ID=...
--      YC_API_KEY=...        (роль: ai.speechkit.user)
--      MINIO_ENDPOINT=https://s3.begemot26.ru
--      MINIO_ACCESS_KEY=...
--      MINIO_SECRET_KEY=...
--      MINIO_USE_SSL=true
--      MINIO_BUCKET_MEDIA=telemost

-- 3. ПОЛУЧЕНИЕ TELEMOST_TOKEN
--    - Перейти: oauth.yandex.ru/client/new
--    - Платформа: Веб-сервисы
--    - Права: telemost-api:conferences.create, conferences.read
--    - Получить OAuth-токен через Debug-URL

-- 4. ПОЛУЧЕНИЕ YC_API_KEY
--    - Создать сервисный аккаунт в Яндекс Облаке
--    - Назначить роль: ai.speechkit.user + storage.uploader
--    - Создать API-ключ в IAM → Сервисные аккаунты

-- 5. ПРОВЕРКА ЗАПИСИ (вручную)
--    export TELEMOST_TOKEN=...
--    bash /opt/telemost/start_meeting.sh "Тест"
--    # → получить join_url, зайти в конфу
--    sleep 30
--    bash /opt/telemost/stop_meeting.sh

-- 6. ПРОВЕРКА ТРАНСКРИБАЦИИ
--    export YC_FOLDER_ID=... YC_API_KEY=... MINIO_ENDPOINT=... MINIO_ACCESS_KEY=...
--    python3 /opt/telemost/transcribe.py /opt/recordings/telemost/meeting_XXX.ogg "Тест"
