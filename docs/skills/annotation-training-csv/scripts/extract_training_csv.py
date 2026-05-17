#!/usr/bin/env python3
"""Convert YuwanLabWriter annotation training exports to compact CSV.

Default output columns are intentionally minimal:

    id,comment,source_text,label

The script accepts an export ZIP, an extracted export directory, or a direct
records.jsonl path.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import zipfile
from pathlib import Path
from typing import Any, Iterable


DEFAULT_COLUMNS = ["id", "comment", "source_text", "label"]
META_COLUMNS = [
    "record_id",
    "annotation_id",
    "evaluation_id",
    "doc_name",
    "section",
    "target_text",
    "tags",
    "adoption",
    "training_candidate",
]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract compact CSV rows from YuwanLabWriter annotation training exports.",
    )
    parser.add_argument(
        "input",
        help="Path to annotation-training-export.zip, an extracted export directory, or records.jsonl.",
    )
    parser.add_argument(
        "output",
        help="Path to write CSV output.",
    )
    parser.add_argument(
        "--only-training-candidates",
        action="store_true",
        help="Only include records where is_training_candidate/training_candidate is true.",
    )
    parser.add_argument(
        "--include-meta",
        action="store_true",
        help="Append traceability columns after the minimal default columns.",
    )
    args = parser.parse_args()

    records = list(load_records(Path(args.input)))
    columns = DEFAULT_COLUMNS + (META_COLUMNS if args.include_meta else [])

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0

    with output_path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            if args.only_training_candidates and not is_training_candidate(record):
                continue
            writer.writerow(row_for_record(record, written, include_meta=args.include_meta))
            written += 1

    print(f"Wrote {written} rows to {output_path}", file=sys.stderr)
    return 0


def load_records(path: Path) -> Iterable[dict[str, Any]]:
    if path.is_dir():
        yield from load_jsonl(path / "records.jsonl")
        return
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            with zf.open("records.jsonl") as fh:
                for raw in fh:
                    line = raw.decode("utf-8").strip()
                    if line:
                        yield json.loads(line)
        return
    yield from load_jsonl(path)


def load_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def row_for_record(record: dict[str, Any], row_id: int, *, include_meta: bool) -> dict[str, Any]:
    annotation = as_dict(record.get("annotation"))
    evaluation = as_dict(record.get("evaluation"))
    context = as_dict(record.get("context"))
    suggestion = as_dict(annotation.get("suggestion"))
    risk = as_dict(annotation.get("risk"))

    row: dict[str, Any] = {
        "id": row_id,
        "comment": first_text(
            annotation.get("content"),
            suggestion.get("reason"),
            risk.get("mitigation"),
            evaluation.get("reason"),
        ),
        "source_text": source_text(record),
        "label": text(evaluation.get("verdict")),
    }

    if include_meta:
        row.update(
            {
                "record_id": text(record.get("record_id")),
                "annotation_id": text(record.get("annotation_id") or annotation.get("id")),
                "evaluation_id": text(record.get("evaluation_id") or evaluation.get("id")),
                "doc_name": text(context.get("doc_name")),
                "section": text(context.get("section")),
                "target_text": first_text(context.get("target_text"), annotation.get("target_text")),
                "tags": join_list(evaluation.get("tags")),
                "adoption": text(evaluation.get("adoption")),
                "training_candidate": "true" if is_training_candidate(record) else "false",
            }
        )
    return row


def source_text(record: dict[str, Any]) -> str:
    annotation = as_dict(record.get("annotation"))
    context = as_dict(record.get("context"))

    current_line = text(context.get("current_line_content"))
    if current_line:
        return current_line

    full_content = text(context.get("current_document_content"))
    if full_content:
        return line_for_range(
            full_content,
            int_or_zero(context.get("range_from")),
            int_or_zero(context.get("range_to")),
        )

    return first_text(context.get("target_text"), annotation.get("target_text"))


def line_for_range(content: str, range_from: int, range_to: int) -> str:
    content_length = len(content)
    start = max(0, min(range_from, content_length))
    end = max(0, min(range_to, content_length))
    if end < start:
        start, end = end, start
    line_start = content.rfind("\n", 0, start) + 1
    end_anchor = start if end == start else max(start, end - 1)
    line_end = content.find("\n", end_anchor)
    if line_end == -1:
        line_end = content_length
    return content[line_start:line_end]


def is_training_candidate(record: dict[str, Any]) -> bool:
    evaluation = as_dict(record.get("evaluation"))
    value = record.get("is_training_candidate", evaluation.get("training_candidate", False))
    return bool(value)


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def first_text(*values: Any) -> str:
    for value in values:
        cleaned = text(value)
        if cleaned:
            return cleaned
    return ""


def text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def join_list(value: Any) -> str:
    if isinstance(value, list):
        return ";".join(text(item) for item in value if text(item))
    return text(value)


def int_or_zero(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
