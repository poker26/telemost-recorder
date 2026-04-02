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

-- 2. ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ в n8n (Settings → Variables)
--
--    TELEMOST_TOKEN    — OAuth-токен приложения Телемост
--    YC_FOLDER_ID      — ID папки в Яндекс Облаке
--    YC_API_KEY        — API-ключ сервисного аккаунта (роль: ai.speechkit.user)
--    YC_S3_BUCKET      — имя бакета (напр. telemost-recordings)
--    YC_S3_KEY_ID      — ключ Object Storage
--    YC_S3_SECRET      — секрет Object Storage

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
--    export YC_FOLDER_ID=... YC_API_KEY=... YC_S3_BUCKET=... ...
--    python3 /opt/telemost/transcribe.py /opt/recordings/telemost/meeting_XXX.ogg "Тест"
