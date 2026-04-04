# telemost-recorder

Запись и транскрибация аудиоконференций Яндекс Телемост через API.

## Архитектура

```
Telegram-команда /meeting_start "Название"
        ↓
n8n workflow → Telemost API → создаёт конференцию с live stream
        ↓
FFmpeg захватывает HLS-поток → .ogg файл на сервере
        ↓
Telegram-команда /meeting_stop
        ↓
n8n → transcribe.py → MinIO (хранение) + YC Object Storage (временно) → SpeechKit async
        ↓
Транскрипт с диаризацией спикеров → Supabase + Telegram
```

### Dual-upload схема

Аудиофайл загружается в два хранилища:

- **MinIO** — долгосрочное хранение записей
- **Yandex Object Storage** — временная копия для SpeechKit (удаляется после транскрибации)

SpeechKit принимает аудио только из Yandex Object Storage (`storage.yandexcloud.net`), поэтому MinIO-URL не подходит для распознавания.

## Файлы

| Файл | Назначение |
|------|-----------|
| `start_meeting.sh` | Создать конференцию через Telemost API, запустить FFmpeg |
| `stop_meeting.sh` | Остановить FFmpeg, вернуть путь к файлу |
| `transcribe.py` | Загрузить в MinIO + YC S3, транскрибировать через SpeechKit, диаризация |
| `n8n_workflow.json` | Импортировать в n8n (Settings → Import Workflow) |
| `setup.sql` | DDL таблицы Supabase + инструкция по установке |

## Требования

- Яндекс 360 для бизнеса (аккаунт на домене организации)
- Yandex Cloud: SpeechKit + Object Storage (бакет для временных файлов)
- MinIO (S3-compatible) для долгосрочного хранения записей
- n8n на сервере
- `ffmpeg`, `jq`, `python3`, `boto3`, `requests`

## Установка

### 1. Зависимости на сервере

```bash
apt install ffmpeg jq python3-venv -y
cd /opt/telemost-recorder
python3 -m venv .venv
./.venv/bin/pip install boto3 requests
mkdir -p /opt/recordings/telemost
chmod +x start_meeting.sh stop_meeting.sh
```

### 2. OAuth-приложение Телемост

1. Перейти на [oauth.yandex.ru/client/new](https://oauth.yandex.ru/client/new)
2. Платформа: **Веб-сервисы**
3. Права: `telemost-api:conferences.create`, `telemost-api:conferences.read`
4. Получить OAuth-токен

### 3. Сервисный аккаунт Яндекс Облако

1. Создать сервисный аккаунт
2. Роли: `ai.speechkit.user` + `storage.uploader`
3. Создать API-ключ
4. Создать статический ключ для Object Storage

### 4. Проектный файл секретов на сервере

Создайте файл `/opt/telemost-recorder/.env.telemost` по шаблону `.env.telemost.example`:

```
TELEMOST_TOKEN=...
YC_FOLDER_ID=...
YC_API_KEY=...
YC_S3_BUCKET=...       (бакет в YC Object Storage, для временных файлов)
YC_S3_KEY_ID=...       (статический ключ YC)
YC_S3_SECRET=...       (секрет YC)
MINIO_ENDPOINT=https://s3.begemot26.ru
MINIO_ACCESS_KEY=...
MINIO_SECRET_KEY=...
MINIO_USE_SSL=true
MINIO_BUCKET_MEDIA=telemost
```

Ограничьте права доступа:

```bash
chmod 600 /opt/telemost-recorder/.env.telemost
```

### 5. Supabase

Выполнить `setup.sql` в SQL-редакторе Supabase.

### 6. n8n workflow

Импортировать `n8n_workflow.json` через **Settings → Import Workflow**.
Настроить credentials: Telegram Bot + Postgres (Supabase) + SSH.

### 7. Автофиниш встречи в Телемосте (без `/meeting_stop`)

Основной workflow (`n8n_workflow.json`) запускается **только из Telegram** (`/meeting_start`, `/meeting_stop`). Когда встречу завершают кнопкой в Телемосте, `recorder.js` останавливается сам, но **n8n и бот не вызываются**, пока вы не настроите отдельный **POST webhook**.

1. Импортировать второй workflow: `n8n_webhook_meeting_finish.json` (или собрать аналог: узел **Webhook** → те же шаги, что после «Notify Stop» в основном workflow).
2. В узле **Webhook** включить режим ответа **«Immediately» / `onReceived`** (чтобы `recorder` не ждал окончания транскрибации по HTTP).
3. **Активировать** workflow и скопировать **Production Webhook URL** (например `https://ваш-домен/webhook/.../telemost-recording-finished`).
4. В `/opt/telemost-recorder/.env.telemost` задать:
   - `TELEMOST_FINISH_WEBHOOK_URL` — этот URL (обязательно для вызова n8n);
   - `TELEGRAM_NOTIFY_CHAT_ID` — числовой id чата Telegram (чтобы узлы «Send Transcript» в webhook-workflow знали, куда писать; без этого транскрипт в БД может сохраниться, но сообщение в Telegram не уйдёт).

Перезапуск отдельных сервисов не нужен: `run_start.sh` подхватывает `.env.telemost` при каждом `/meeting_start`.

Проверка лога бота: `tail -f /tmp/telemost_recorder.log` — при старте будет строка про задан или не задан `TELEMOST_FINISH_WEBHOOK_URL`.

## Использование

```
/meeting_start Еженедельный синк   — создать встречу и начать запись
/meeting_stop                      — остановить запись и запустить транскрибацию
```

После `/meeting_stop` транскрипт с разметкой спикеров придёт в Telegram и сохранится в Supabase.

### SSH ноды в workflow

В workflow используются SSH-ноды (`Start Meeting`, `Stop Meeting`, `Run Transcription`), которые выполняют команды на сервере и загружают секреты из `/opt/telemost-recorder/.env.telemost`.

## Формат транскрипта

```
[Спикер 1]
Добрый день, начнём совещание.

[Спикер 2]
Да, я готов. По первому пункту...
```

## Ограничения

- Запись через live stream доступна только когда **вы инициатор** встречи
- SpeechKit: до 4 часов / 1 ГБ на файл
- Результаты распознавания хранятся на серверах SpeechKit 3 суток
- Диаризация: номера спикеров без имён (сопоставление вручную)
