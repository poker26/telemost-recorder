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
| `start_meeting.sh` | Создать конференцию через Telemost API, запустить recorder |
| `set_recorder_display_name.sh` | Сохранить имя в лобби Телемоста (`telemost_recorder_profile.json`) |
| `save_avatar_from_telegram.sh` | Скачать фото из Telegram → `.telemost_bot_avatar.jpg` |
| `stop_meeting.sh` | Остановить FFmpeg, вернуть путь к файлу |
| `transcribe.py` | Загрузить в MinIO + YC S3, транскрибировать через SpeechKit, диаризация |
| `n8n_workflow.json` | Импортировать в n8n (Settings → Import Workflow) |
| `n8n_webhook_meeting_finish.json` | Отдельный workflow: webhook автофиниша |
| `n8n_webhook_recall_transcript.json` | Webhook: саммари по `transcript_id` из Supabase или по тексту в теле запроса (`curl`) |
| `n8n_subworkflow_meeting_summary.json` | Sub-workflow: саммари через OpenRouter → Telegram |
| `scripts/generate_n8n_subworkflow_meeting_summary.py` | Пересборка JSON sub-workflow (UTF-8) при правках |
| `setup.sql` | DDL таблицы Supabase + инструкция по установке |
| `docs/meeting_summary_prompt.md` | Текст промпта саммари (для редактора и n8n) |

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
chmod +x start_meeting.sh join_meeting.sh stop_meeting.sh run_start.sh run_join.sh run_stop.sh run_transcribe.sh set_recorder_display_name.sh save_avatar_from_telegram.sh
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
Настроить credentials: **TeleTranscript** (Telegram Bot API в списке credential n8n) + Postgres (Supabase) + SSH.

Узел **Route Command** — Switch в режиме **Expression** (см. [документацию Switch](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.switch/)): задаётся **Number of Outputs** и выражение **Output Index** (число 0…N−1). Так можно на одном узле развести все команды бота. Устаревший Switch **typeVersion 1** в режиме Rules/Expression физически имеет только четыре выхода; для большего числа веток нужен Switch **v2+** (см. [PR #7499](https://github.com/n8n-io/n8n/pull/7499)) — в экспорте репозитория для **Route Command** указан **typeVersion 3**.

#### Имя и аватар бота **в Телемосте** (лобби перед «Подключиться»)

Это **не** настройки профиля Telegram-бота в мессенджере, а имя и фото участника, который заходит в конференцию через Puppeteer (`recorder.js`).

- **Файл на сервере:** рядом со скриптами создаётся/обновляется `telemost_recorder_profile.json` (ключ `display_name`). Его читают `start_meeting.sh` и `join_meeting.sh` и экспортируют `BOT_DISPLAY_NAME` перед запуском `recorder.js`.
- **Аватар:** скрипт `save_avatar_from_telegram.sh` кладёт изображение в `.telemost_bot_avatar.jpg`. `recorder.js` подхватывает его автоматически (или путь из `BOT_LOBBY_AVATAR_PATH` в `.env.telemost`). На сервере у скриптов должны быть права на выполнение (см. `chmod` в п. «Установка»); иначе n8n по SSH вернёт `Permission denied`.
- **Секрет на сервере:** в `.env.telemost` добавьте **`TELEGRAM_BOT_TOKEN`** (тот же токен, что у бота в n8n), иначе загрузка фото с Telegram на диск сервера невозможна.

Команды в чате с ботом:

- `/telemost_name EN Meeting recorder` — сохранить отображаемое имя в лобби для следующих записей.
- `/telemost_name --reset` — убрать имя из профиля и снова использовать `BOT_DISPLAY_NAME` из `.env.telemost`.
- Отправьте **изображение** с подписью **`/telemost_photo`** — файл скачается на сервер как аватар лобби.

Загрузка фото в UI Телемоста зависит от вёрстки: в `recorder.js` перебираются скрытые `input[type="file"]` и типичные кнопки/тестиды. Если релиз Телемоста изменил разметку, по логу строка `[recorder] Аватар лобби:` подскажет, сработало ли.

**Важно:** `/telemost_name` и `/telemost_photo` выполняют SSH-команды на сервере для всех пользователей бота одинаково. Если бот не только для личного пользования, имеет смысл ограничить, кто может с ним переписываться (или вернуть проверку по `chat.id` в узлах **Build Telemost Name/Photo** в n8n).

#### Саммари после транскрипта (OpenRouter)

1. Импортировать **`n8n_subworkflow_meeting_summary.json`** отдельным workflow, **активировать** его. У первого узла (**When Executed by Another Workflow**) в режиме **Input data mode** должно быть **Accept all data** (`passthrough` в JSON) — иначе n8n покажет предупреждение и родительский **Execute Workflow** не сможет передать произвольный объект.
2. В узле **OpenRouter Chat** выбрать уже настроенный в n8n credential типа **Header Auth** (часто имя `OpenRouter`): заголовок **`Authorization`**, значение **`Bearer <ваш_ключ_OpenRouter>`**. Если имя credential другое — создайте или перепривяжите в узле.
3. Импортировать или обновить **`n8n_workflow.json`** и **`n8n_webhook_meeting_finish.json`**. В узле **Execute Meeting Summary** при необходимости заново выберите sub-workflow по имени (id в файле: `a1b2c3d4-e5f6-7890-abcd-ef00summary01`; после импорта n8n может показать другой id — важно указать правильный workflow в списке).
4. Модель и системный промпт настраиваются в узле **Build OpenRouter Request** в sub-workflow; подробный русскоязычный шаблон — в `docs/meeting_summary_prompt.md`. Узел **Prepare Summary Payload** в репозитории — **Edit Fields (Set)** с маппингом из `$json`, не Code с `$input` (иначе в n8n возможна ошибка «Referenced node doesn't exist» для несуществующего узла `input`).

### 7. Автофиниш встречи в Телемосте (без `/meeting_stop`)

Основной workflow (`n8n_workflow.json`) запускается **только из Telegram** (`/meeting_start`, `/meeting_stop`). Когда встречу завершают кнопкой в Телемосте, `recorder.js` останавливается сам, но **n8n и бот не вызываются**, пока вы не настроите отдельный **POST webhook**.

1. Импортировать второй workflow: `n8n_webhook_meeting_finish.json` (или собрать аналог: **Webhook** → уведомление в Telegram «Встреча завершена, начинаю расшифровку» → транскрибация и далее как в основном потоке).
2. В узле **Webhook** включить режим ответа **«Immediately» / `onReceived`** (чтобы `recorder` не ждал окончания транскрибации по HTTP).
3. **Активировать** workflow и скопировать **Production Webhook URL** (например `https://ваш-домен/webhook/.../telemost-recording-finished`).
4. В `/opt/telemost-recorder/.env.telemost` задать `TELEMOST_FINISH_WEBHOOK_URL` (обязательно для вызова n8n).
5. **Куда слать транскрипт в Telegram:** при старте через бота узел **Start Meeting** передаёт `chat.id` на сервер; он сохраняется в `/tmp/telemost_meeting.json` как `telegram_chat_id` и попадает в webhook как `chat_id`. Если встречу запускали не через обновлённый workflow, задайте запасной вариант: `TELEGRAM_NOTIFY_CHAT_ID` в `.env.telemost`.

Перезапуск отдельных сервисов не нужен: `run_start.sh` подхватывает `.env.telemost` при каждом `/meeting_start`. После обновления репозитория **импортируйте заново** `n8n_workflow.json` (или вручную добавьте второй аргумент в команду SSH «Start Meeting», см. репозиторий).

Проверка лога бота: `tail -f /tmp/telemost_recorder.log` — при старте будет строка про задан или не задан `TELEMOST_FINISH_WEBHOOK_URL`.

### 8. Webhook «повтор»: саммари по строке из Supabase или по готовому тексту

Импортируйте **`n8n_webhook_recall_transcript.json`**, укажите credential **Supabase Postgres** (как в других workflow), активируйте workflow. Узел **Execute Meeting Summary** должен ссылаться на sub-workflow саммари (см. п. 6).

**Путь webhook:** `POST .../webhook/.../telemost-recall-transcript` (точный **Production URL** скопируйте из узла Webhook после активации). Ответ HTTP приходит сразу (`onReceived`), саммари уходит в Telegram асинхронно.

**Тело JSON (один из вариантов):**

- **Из БД:** `transcript_id` — значение `meeting_transcripts.id`, плюс обязательно `chat_id` (куда слать в Telegram), опционально `source`. Поля **`transcript_id` и `transcript` одновременно не передавайте.**
- **Готовый текст:** `title`, `transcript`, `chat_id`, опционально `source` — без `transcript_id`.

**Опциональная защита:** в узле **Normalize Recall Request** задайте константу `EXPECT` (длинная случайная строка). Тогда в запросе нужен заголовок **`X-Recall-Secret`** или поле **`secret`** в JSON с тем же значением. Пустой `EXPECT` — проверка отключена (не рекомендуется для публичного URL).

**Пример `curl` (саммари по уже сохранённой строке):**

```bash
curl -X POST "https://ВАШ-N8N/webhook/ВАШ-ID/telemost-recall-transcript" -H "Content-Type: application/json" -d "{\"transcript_id\": 42, \"chat_id\": \"ВАШ_TELEGRAM_CHAT_ID\", \"source\": \"curl_db\"}"
```

**Пример с готовым текстом (файл `payload.json`):** поля `title`, `transcript`, `chat_id`, `source`.

Путь к аудио на диске / в MinIO этот webhook **не трогает** — только чтение текста из таблицы или из тела запроса.

## Использование

```
/meeting_start Еженедельный синк   — создать встречу (API) и начать запись
/meeting_join https://telemost.yandex.ru/j/…  — записать встречу по чужой ссылке (в том же сообщении)
/meeting_stop                      — остановить запись и запустить транскрибацию
/telemost_name Имя в комнате      — имя бота в лобби Телемоста
/telemost_name --reset             — сброс имени к BOT_DISPLAY_NAME из .env
/telemost_photo                    — подпись к фото: аватар в лобби (нужен TELEGRAM_BOT_TOKEN на сервере)
```

Опционально после ссылки в `/meeting_join` можно указать **название** для отчёта (текст после URL). Если не указать — подставится заголовок вида «Встреча по ссылке» с датой.

После `/meeting_stop` (или при автофинишe в Телемосте, если настроен webhook) транскрипт с разметкой спикеров придёт в Telegram и сохранится в Supabase.

В [@BotFather](https://t.me/BotFather) можно добавить команду `meeting_join` в меню бота — по желанию.

Время в сообщениях бота и в поле «готово» транскрипта задаётся как **московское** (`Europe/Moscow`), не UTC.

### SSH ноды в workflow

В workflow используются SSH-ноды (`Start Meeting`, `Join Meeting`, `Stop Meeting`, `Run Transcription`, `SSH Set Telemost Name`, `SSH Save Telemost Avatar`), которые выполняют команды на сервере; секреты Телемоста и записи подхватываются из `/opt/telemost-recorder/.env.telemost` внутри `run_*.sh` и дочерних скриптов.

## Формат транскрипта

```
[Спикер 1]
Добрый день, начнём совещание.

[Спикер 2]
Да, я готов. По первому пункту...
```

## Ограничения

- **`/meeting_start`** создаёт конференцию через Cloud API (live stream); нужен `TELEMOST_TOKEN`. **`/meeting_join`** токен API для создания встречи не использует — только ссылка и тот же пайплайн записи/остановки.
- Комната ожидания: пока организатор не пустил бота, полноценной записи эфира нет.
- SpeechKit: до 4 часов / 1 ГБ на файл
- Результаты распознавания хранятся на серверах SpeechKit 3 суток
- Диаризация: номера спикеров без имён (сопоставление вручную)
