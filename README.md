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
n8n → transcribe.py → Yandex Object Storage → SpeechKit async
        ↓
Транскрипт с диаризацией спикеров → Supabase + Telegram
```

## Файлы

| Файл | Назначение |
|------|-----------|
| `start_meeting.sh` | Создать конференцию через Telemost API, запустить FFmpeg |
| `stop_meeting.sh` | Остановить FFmpeg, вернуть путь к файлу |
| `transcribe.py` | Загрузить в S3, транскрибировать через SpeechKit, диаризация |
| `n8n_workflow.json` | Импортировать в n8n (Settings → Import Workflow) |
| `setup.sql` | DDL таблицы Supabase + инструкция по установке |

## Требования

- Яндекс 360 для бизнеса (аккаунт на домене организации)
- Yandex Cloud: SpeechKit + Object Storage
- n8n на сервере
- `ffmpeg`, `jq`, `python3`, `boto3`, `requests`

## Установка

### 1. Зависимости на сервере

```bash
apt install ffmpeg jq python3-pip -y
pip3 install boto3 requests
mkdir -p /opt/telemost /opt/recordings/telemost
cp start_meeting.sh stop_meeting.sh transcribe.py /opt/telemost/
chmod +x /opt/telemost/*.sh
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
YC_S3_BUCKET=...
YC_S3_KEY_ID=...
YC_S3_SECRET=...
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

## Использование

```
/meeting_start Еженедельный синк   — создать встречу и начать запись
/meeting_stop                      — остановить запись и запустить транскрибацию
```

После `/meeting_stop` транскрипт с разметкой спикеров придёт в Telegram и сохранится в Supabase.

### 7. SSH ноды в workflow

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
