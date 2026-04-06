# Саммари встречи — статус сборки

**Сборка в репозитории выполнена:** `n8n_subworkflow_meeting_summary.json`, обновлены `n8n_workflow.json` и `n8n_webhook_meeting_finish.json`, генератор `scripts/generate_n8n_subworkflow_meeting_summary.py`. Подробности для продакшена — в **README** (раздел про OpenRouter).

## Что уже есть

- [`docs/meeting_summary_prompt.md`](meeting_summary_prompt.md) — текст промпта (RU).
- Файл `n8n_subworkflow_meeting_summary.json` мог быть частично сгенерирован/повреждён кодировкой — проверьте содержимое и при необходимости удалите и пересоздайте из шага 1 ниже.

## Что сделать после включения Agent mode

1. **Sub-workflow** `Telemost — Meeting Summary (sub-workflow)`:
   - Триггер: **When Executed by Another Workflow** (принять все данные).
   - **Code** `Build OpenRouter Request`: константы `OPENROUTER_MODEL`, `SYSTEM_PROMPT` (из `docs/meeting_summary_prompt.md`), сборка `requestBody` для OpenRouter.
   - **HTTP Request** `POST` `https://openrouter.ai/api/v1/chat/completions`, тело `={{ JSON.stringify($json.requestBody) }}`, credential — **ваши существующие OpenRouter** (Header `Authorization: Bearer …` или тип, который у вас уже настроен).
   - **Code** разбор ответа → **IF** по ошибке → **Telegram** успех / ошибка.

2. **Родительские** [`n8n_workflow.json`](../n8n_workflow.json) и [`n8n_webhook_meeting_finish.json`](../n8n_webhook_meeting_finish.json):
   - Ветка успеха после `Parse Transcript`: только **Build Supabase Row** (убрать параллель с **Send Transcript** отсюда).
   - После **Build Supabase Row** два параллельных выхода: **Save to Supabase** → **Send Transcript** и **Prepare Summary Payload** (Code, только `$input` из Build) → **Execute Workflow** (sub-workflow, `continueOnFail: true`). Так в **Prepare** не используется `$('…')`, и n8n не падает с «Referenced node doesn't exist».
   - **Prepare Summary Payload** (Telegram-ветка): `title`, `transcript`, `chat_id` из `Parse Transcript` + `Telegram Trigger`; (webhook-ветка): `chat_id` из `Normalize Webhook Payload`, `source`: `webhook_auto_finish`.

3. **README**: импорт sub-workflow, привязка credential OpenRouter к узлу HTTP, выбор workflow в **Execute Workflow**, активация sub-workflow.

4. Запуск `python verify_workflow_contract.py` и `git push`.

## ID в репозитории (для ссылок)

Задуманный id sub-workflow: `a1b2c3d4-e5f6-7890-abcd-ef00summary01` — после импорта n8n может назначить другой; в узле **Execute Workflow** выберите workflow по имени.

---

## Текущие проблемы в `n8n_subworkflow_meeting_summary.json` (исправить в Agent)

- В **name** и в текстах Telegram — **битая UTF-8** (например `вЂ"` вместо длинного тире, кракозябры в `SYSTEM_PROMPT`).
- В узлах **Send Summary** / **Send Summary Error** — исправить `text` на шаблоны **только в ASCII** или скопировать русский текст заново в редакторе n8n (не через PowerShell `replace`).

### Рекомендуемый `SYSTEM_PROMPT` (ASCII, ответ модели — по-русски)

Вставить в узел **Build OpenRouter Request** целиком (в n8n или в JSON как одна строка с `\n`):

```
You are a meeting transcript analyst. Output MUST be in Russian, structured Markdown.

Rules:
- Do not invent facts absent from the transcript.
- If the meeting was brainstorming with no formal decisions, say so; list only ideas that appear in the text.
- List decisions only when clearly stated in the text.

Sections: 1) Brief 2) Discussion topics 3) Decisions/agreements (or "none fixed") 4) Ideas 5) Open questions / next steps.

Full human-editable template for editors: docs/meeting_summary_prompt.md in the repo.
```

### `jsCode` для **Build OpenRouter Request** (корректные `$`, без `.replace('$', …)`)

Используйте `.join('\n')` для массива строк промпта; для обрезки — `'\n\n[truncated]'`.

Ключевые строки: `const input = $input.first().json;`, сборка `requestBody` с `messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }]`, `return [{ json: { chat_id, title, source, requestBody } }];`.

### `jsCode` для **Parse OpenRouter Response**

Оставить как в файле: `const build = $('Build OpenRouter Request').first().json;`, разбор `body.choices[0].message.content`, ошибки из `row.error` / `body.error`. Сообщения об ошибках можно оставить на английском в коде, чтобы не ломать кодировку в JSON.

---

## Родительские workflow: связи

### Общее для `n8n_workflow.json` и `n8n_webhook_meeting_finish.json`

- **Transcript Has Error?** — ветка «успех» (без ошибки): только **Build Supabase Row** (убрать второй выход на **Send Transcript**).
- **Build Supabase Row** → **два** исходящих: **Save to Supabase** (далее **Send Transcript**) и **Prepare Summary Payload** (параллельно с Save).
- **Prepare Summary Payload** → **Execute Workflow** (`continueOnFail: true`), workflow — импортированный sub-workflow саммари.

### Узел **Prepare Summary Payload** (Code)

Вход — прямой выход **Build Supabase Row** (тот же объект, что идёт в INSERT): в **Build** уже добавлены `_n8n_chat_id` и `_n8n_source`. В **Prepare** только `$input`, без `$('…')`:

```javascript
const build = $input.first().json;
return [{
  json: {
    title: String(build.title ?? ''),
    transcript: String(build.transcript ?? ''),
    chat_id: String(build._n8n_chat_id ?? ''),
    source: String(build._n8n_source ?? 'telegram_bot'),
  },
}];
```

Для webhook в `source` по умолчанию подставьте `'webhook_auto_finish'`, если поле пустое.

### Узел **Execute Workflow** (n8n)

- Тип: **Execute Workflow** / `n8n-nodes-base.executeWorkflow` (актуальная `typeVersion` из UI).
- Указать целевой workflow по id или по списку (после импорта `n8n_subworkflow_meeting_summary.json`).
- Включить **Continue On Fail**, чтобы сбой LLM не ронял основной сценарий.

### Фрагмент `connections` (логика)

- `"Transcript Has Error?": { "main": [ [ Send Transcribe Error ], [ Build Supabase Row ] ] }` — **ровно один** узел во второй ветке.
- `"Build Supabase Row": { "main": [ [ Save to Supabase, Prepare Summary Payload ] ] }`, затем `"Save to Supabase": { "main": [ [ Send Transcript ] ] }`.
- `"Prepare Summary Payload": { "main": [ [ { node: Execute Workflow, ... } ] ] }`.

После правок: `node -e "JSON.parse(require('fs').readFileSync('n8n_subworkflow_meeting_summary.json','utf8'))"` (или эквивалент на Python) и при наличии — `python verify_workflow_contract.py`.
