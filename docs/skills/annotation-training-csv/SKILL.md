---
name: annotation-training-csv
description: Convert SuperLeaf annotation training exports, records.jsonl files, or export ZIPs into compact CSV training datasets. Use this whenever the user mentions annotation-training-export, records.jsonl, 批注训练数据, clean training data, CSV dataset, reducing token cost, or turning annotation evaluations into LLM fine-tuning/evaluation rows.
nav_exclude: true
---

# Annotation Training CSV

Use this skill to turn SuperLeaf annotation training exports into a clean,
small CSV file for downstream training, evaluation, or manual review.

The goal is token economy: keep only the fields needed for the next training
step, and avoid carrying hashes, ranges, full threads, tags, or document
metadata unless the user explicitly asks for audit columns.

## Default Output

Always default to this CSV schema:

```csv
id,comment,source_text,label
```

- `id`: integer starting from `0`, assigned during extraction.
- `comment`: the annotation or review comment.
- `source_text`: the original source text. Prefer `context.current_line_content`;
  fall back to the line containing the range in old exports; finally fall back
  to `target_text`.
- `label`: the user verdict, normally `positive` or `negative`.

Do not include `surrounding_before`, `surrounding_after`,
`current_document_content`, raw thread messages, document hashes, or ranges in
the default CSV. Those fields are useful for audit/debug, but they increase
token cost and may leak more context than needed.

## Deterministic Script

Prefer the bundled script instead of asking an LLM to parse JSON manually:

```bash
python3 docs/skills/annotation-training-csv/scripts/extract_training_csv.py \
  "/path/to/annotation-training-export.zip" \
  training_data.csv \
  --only-training-candidates
```

The script accepts any of these inputs:

- an export ZIP containing `records.jsonl`
- an extracted export directory containing `records.jsonl`
- a direct `records.jsonl` path

Use `--include-meta` only when the user needs traceability columns for audit.

## Skill Download

To copy this project-local skill into another workspace with npm tooling:

```bash
npm exec --yes degit OhMyYuwan/SuperLeaf/docs/skills/annotation-training-csv ./annotation-training-csv
```

If the repository is private, clone it with GitHub authentication first and
copy `docs/skills/annotation-training-csv/` manually.

## Workflow

1. Locate the export ZIP, export directory, or `records.jsonl`.
2. Run the bundled script to produce CSV.
3. Inspect the first few rows and confirm the columns are minimal.
4. If the user needs only selected training data, rerun with
   `--only-training-candidates`.
5. If the user needs auditability, rerun with `--include-meta`, but keep that
   as a separate file from the token-efficient training CSV.

## Label Rules

Use `evaluation.verdict` as the label. Preserve the original vocabulary instead
of inventing new labels:

- `positive`: useful annotation or review
- `negative`: not useful annotation or review

When a record has no verdict, leave `label` empty rather than guessing.
