#!/usr/bin/env python3
"""Генерирует n8n_subworkflow_meeting_summary.json (UTF-8 без BOM). Запуск из корня: python scripts/generate_n8n_subworkflow_meeting_summary.py"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "n8n_subworkflow_meeting_summary.json"

WORKFLOW_ID = "a1b2c3d4-e5f6-7890-abcd-ef00summary01"

JS_BUILD = r"""const OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const MAX_TRANSCRIPT_CHARS = 100000;
const SYSTEM_PROMPT = [
  'You are a meeting transcript analyst. The entire answer MUST be in Russian, as structured Markdown.',
  '',
  'Rules:',
  '- Do not invent facts that are not in the transcript.',
  '- If the meeting was brainstorming without formal decisions, say so; list only ideas that appear in the text.',
  '- List decisions and agreements only when they clearly follow from the text.',
  '',
  'Structure: 1) Brief 2) Discussion topics 3) Decisions/agreements (or none) 4) Ideas 5) Open questions and next steps.',
  'Human-editable template in repo: docs/meeting_summary_prompt.md',
].join('\n');
const input = $input.first().json;
const title = String(input.title ?? '');
const rawTranscript = String(input.transcript ?? '');
const chatId = String(input.chat_id ?? '');
const source = String(input.source ?? '');
let transcript = rawTranscript;
if (transcript.length > MAX_TRANSCRIPT_CHARS) {
  transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[truncated for API]';
}
const userContent = ['Title: ' + title, 'Source: ' + (source || 'n/a'), '', 'Transcript:', transcript].join('\n');
const requestBody = {
  model: OPENROUTER_MODEL,
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ],
};
return [{ json: { chat_id: chatId, title, source, requestBody } }];"""

JS_PARSE = r"""const build = $('Build OpenRouter Request').first().json;
const chatId = build.chat_id;
const title = build.title;
const row = $input.first().json;
let errMsg = '';
let summaryText = '';
if (row.error) {
  errMsg = String(row.error.message || row.error);
}
const body = row.body !== undefined && row.body !== null ? row.body : row;
try {
  if (body && body.error) {
    errMsg = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
  } else if (body && body.choices && body.choices[0] && body.choices[0].message) {
    summaryText = String(body.choices[0].message.content || '').trim();
  }
} catch (e) {
  errMsg = e.message || String(e);
}
if (!summaryText && !errMsg) {
  errMsg = 'Empty or unexpected OpenRouter response';
}
const MAX_TG = 3900;
if (summaryText.length > MAX_TG) {
  summaryText = summaryText.slice(0, MAX_TG) + '\n\n...(truncated for Telegram)';
}
return [{ json: { chat_id: chatId, title, summary_text: summaryText, error: errMsg || null } }];"""


def main() -> None:
    workflow = {
        "id": WORKFLOW_ID,
        "name": "Telemost — Meeting Summary (sub-workflow)",
        "nodes": [
            {
                "parameters": {},
                "id": "sw-trigger-001",
                "name": "When Executed by Another Workflow",
                "type": "n8n-nodes-base.executeWorkflowTrigger",
                "typeVersion": 1.1,
                "position": [240, 300],
            },
            {
                "parameters": {"jsCode": JS_BUILD},
                "id": "sw-build-002",
                "name": "Build OpenRouter Request",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [460, 300],
            },
            {
                "parameters": {
                    "method": "POST",
                    "url": "https://openrouter.ai/api/v1/chat/completions",
                    "authentication": "genericCredentialType",
                    "genericAuthType": "httpHeaderAuth",
                    "sendHeaders": True,
                    "headerParameters": {
                        "parameters": [
                            {"name": "Content-Type", "value": "application/json"},
                            {
                                "name": "HTTP-Referer",
                                "value": "https://github.com/poker26/telemost-recorder",
                            },
                        ]
                    },
                    "sendBody": True,
                    "specifyBody": "json",
                    "jsonBody": "={{ JSON.stringify($json.requestBody) }}",
                    "options": {
                        "response": {"response": {"responseFormat": "json"}}
                    },
                },
                "id": "sw-http-003",
                "name": "OpenRouter Chat",
                "type": "n8n-nodes-base.httpRequest",
                "typeVersion": 4.2,
                "position": [680, 300],
                "credentials": {"httpHeaderAuth": {"name": "OpenRouter"}},
                "continueOnFail": True,
            },
            {
                "parameters": {"jsCode": JS_PARSE},
                "id": "sw-parse-004",
                "name": "Parse OpenRouter Response",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [900, 300],
            },
            {
                "parameters": {
                    "conditions": {
                        "string": [
                            {
                                "value1": "={{ $json.error }}",
                                "operation": "isNotEmpty",
                            }
                        ]
                    }
                },
                "id": "sw-if-005",
                "name": "Summary Failed?",
                "type": "n8n-nodes-base.if",
                "typeVersion": 1,
                "position": [1120, 300],
            },
            {
                "parameters": {
                    "chatId": "={{ $json.chat_id }}",
                    "text": "=📌 Саммари встречи — *{{ $json.title }}*\n\n{{ $json.summary_text }}",
                    "additionalFields": {"parse_mode": "Markdown"},
                },
                "id": "sw-tg-ok-006",
                "name": "Send Summary",
                "type": "n8n-nodes-base.telegram",
                "typeVersion": 1.2,
                "position": [1340, 200],
                "credentials": {"telegramApi": {"name": "Telegram Bot"}},
            },
            {
                "parameters": {
                    "chatId": "={{ $json.chat_id }}",
                    "text": "=❌ Не удалось построить саммари:\n\n`{{ $json.error }}`",
                    "additionalFields": {"parse_mode": "Markdown"},
                },
                "id": "sw-tg-err-007",
                "name": "Send Summary Error",
                "type": "n8n-nodes-base.telegram",
                "typeVersion": 1.2,
                "position": [1340, 400],
                "credentials": {"telegramApi": {"name": "Telegram Bot"}},
            },
        ],
        "connections": {
            "When Executed by Another Workflow": {
                "main": [[{"node": "Build OpenRouter Request", "type": "main", "index": 0}]]
            },
            "Build OpenRouter Request": {
                "main": [[{"node": "OpenRouter Chat", "type": "main", "index": 0}]]
            },
            "OpenRouter Chat": {
                "main": [[{"node": "Parse OpenRouter Response", "type": "main", "index": 0}]]
            },
            "Parse OpenRouter Response": {
                "main": [[{"node": "Summary Failed?", "type": "main", "index": 0}]]
            },
            "Summary Failed?": {
                "main": [
                    [{"node": "Send Summary Error", "type": "main", "index": 0}],
                    [{"node": "Send Summary", "type": "main", "index": 0}],
                ]
            },
        },
        "settings": {"executionOrder": "v1"},
        "meta": {"templateCredsSetupCompleted": False},
    }
    OUT.write_text(
        json.dumps(workflow, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
