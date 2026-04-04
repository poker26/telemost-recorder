#!/usr/bin/env python3
"""
Проверка согласованности:
  workflow_contract.json ↔ setup.sql (колонки meeting_transcripts)
  ↔ transcribe.py (ключи output JSON)
  ↔ n8n_workflow.json (Build Supabase Row, Save to Supabase / executeQuery).

Запуск из корня репозитория:
  python verify_workflow_contract.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_contract() -> dict:
    path = ROOT / "workflow_contract.json"
    return json.loads(path.read_text(encoding="utf-8"))


def parse_setup_sql_columns() -> list[str]:
    text = (ROOT / "setup.sql").read_text(encoding="utf-8")
    match = re.search(
        r"CREATE TABLE IF NOT EXISTS meeting_transcripts\s*\((.*?)\);",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    if not match:
        raise RuntimeError("В setup.sql не найден CREATE TABLE meeting_transcripts")
    block = match.group(1)
    columns: list[str] = []
    for line in block.splitlines():
        line = line.strip()
        if not line or line.startswith("--"):
            continue
        parts = line.split()
        if not parts:
            continue
        col = parts[0].strip('"')
        if col.upper() in ("PRIMARY", "CONSTRAINT", "UNIQUE", "CHECK", "FOREIGN"):
            continue
        if col.endswith(","):
            col = col[:-1]
        columns.append(col)
    return columns


def parse_transcribe_output_keys() -> set[str]:
    text = (ROOT / "transcribe.py").read_text(encoding="utf-8")
    match = re.search(r"output\s*=\s*\{([^}]+)\}", text, re.DOTALL)
    if not match:
        raise RuntimeError("В transcribe.py не найден блок output = { ... }")
    block = match.group(1)
    keys: set[str] = set()
    for line in block.splitlines():
        line = line.strip()
        if ":" in line and not line.startswith("#"):
            key = line.split(":", 1)[0].strip().strip('"').strip("'")
            if key:
                keys.add(key)
    return keys


def extract_n8n_build_js() -> str:
    text = (ROOT / "n8n_workflow.json").read_text(encoding="utf-8")
    match = re.search(
        r'"jsCode": "([^"]*(?:\\.[^"]*)*)"\s*\},\s*\n\s*"name": "Build Supabase Row"',
        text,
        re.DOTALL,
    )
    if not match:
        raise RuntimeError("Не удалось извлечь jsCode у узла Build Supabase Row")
    raw = match.group(1)
    return raw.replace("\\n", "\n").replace('\\"', '"')


def extract_n8n_build_row_keys(contract_order: list[str]) -> None:
    js = extract_n8n_build_js()
    positions: list[tuple[int, str]] = []
    for key in contract_order:
        needle = f"{key}:"
        idx = js.find(needle)
        if idx < 0:
            raise RuntimeError(
                f"В jsCode Build Supabase Row не найдено поле {key!r} (ожидается `{needle}`)"
            )
        positions.append((idx, key))
    for previous, current in zip(positions, positions[1:]):
        if previous[0] >= current[0]:
            raise RuntimeError(
                f"Порядок полей в Build Supabase Row: {current[1]} идёт раньше {previous[1]}"
            )


def extract_postgres_insert_columns_from_workflow() -> list[str]:
    text = (ROOT / "n8n_workflow.json").read_text(encoding="utf-8")
    m_insert = re.search(
        r"INSERT INTO\s+public\.meeting_transcripts\s*\(([^)]+)\)\s*VALUES",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if m_insert:
        cols = [c.strip().strip('"') for c in m_insert.group(1).split(",")]
        return [c for c in cols if c]
    m_cols = re.search(
        r'"name": "Save to Supabase"[^}]*"columns": "([^"]+)"',
        text,
        re.DOTALL,
    )
    if not m_cols:
        raise RuntimeError("Save to Supabase: нет INSERT и нет columns")
    return [c.strip() for c in m_cols.group(1).split(",") if c.strip()]


def main() -> None:
    contract = load_contract()
    contract_build = contract["build_supabase_row_keys_in_order"]
    contract_insert = contract["postgres_insert_sql_column_order"]
    contract_transcribe = set(contract["transcribe_stdout_keys"])

    if contract_build != contract_insert:
        print(
            "ERROR: в workflow_contract.json build_supabase_row_keys_in_order "
            "и postgres_insert_sql_column_order должны совпадать",
            file=sys.stderr,
        )
        sys.exit(1)

    sql_columns = parse_setup_sql_columns()
    insertable = set(sql_columns) - {"id", "created_at"}

    if set(contract_insert) != insertable:
        print("ERROR: колонки INSERT ≠ setup.sql (без id, created_at)", file=sys.stderr)
        print(f"  contract: {sorted(contract_insert)}", file=sys.stderr)
        print(f"  setup:    {sorted(insertable)}", file=sys.stderr)
        sys.exit(1)

    transcribe_keys = parse_transcribe_output_keys()
    if transcribe_keys != contract_transcribe:
        print("ERROR: ключи output в transcribe.py ≠ transcribe_stdout_keys в контракте", file=sys.stderr)
        print(f"  python:   {sorted(transcribe_keys)}", file=sys.stderr)
        print(f"  contract: {sorted(contract_transcribe)}", file=sys.stderr)
        sys.exit(1)

    if not set(contract_build).issubset(transcribe_keys):
        print("ERROR: поля Build Supabase Row должны быть подмножеством ключей transcribe output", file=sys.stderr)
        print(f"  build:    {sorted(contract_build)}", file=sys.stderr)
        print(f"  python:   {sorted(transcribe_keys)}", file=sys.stderr)
        sys.exit(1)

    extract_n8n_build_row_keys(contract_build)

    n8n_insert = extract_postgres_insert_columns_from_workflow()
    if n8n_insert != contract_insert:
        print("ERROR: колонки в узле Save to Supabase ≠ контракт", file=sys.stderr)
        print(f"  n8n:      {n8n_insert}", file=sys.stderr)
        print(f"  contract: {contract_insert}", file=sys.stderr)
        sys.exit(1)

    print("verify_workflow_contract: OK")


if __name__ == "__main__":
    main()
