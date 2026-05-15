---
layout: default
title: 批注训练数据
nav_order: 6
---

# 批注训练数据

YuwanLabWriter 会记录并保留与 Agent 交互产生的数据，包括批注、建议、风险提示、用户评价、采用情况、标签和是否加入训练数据集。这些数据用于回看审稿过程、导出训练样本，以及后续构建项目级写作知识库。

## 保留了哪些数据

- Agent 产生的批注、建议、风险提示和相关说明。
- 用户对批注的评价：有用 / 无用、原因、标签、采用情况。
- `加入训练数据集` 标记，用于导出时筛选高价值样本。
- 批注对应的文档、章节、range、目标文本和所在行内容。

当前导出格式不会导出整篇论文正文。导出包只保留批注所在行内容、文档 hash 和必要元信息；旧版本导出的包可能包含 `current_document_content` 或 `surrounding_before` / `surrounding_after`，建议重新导出。

## 导出训练数据

在项目右侧 Team / Agent 面板中使用“批注训练数据”导出入口。可以打开“仅导出已标记为训练数据的数据”，只导出勾选过 `加入训练数据集` 的评价样本。

导出 ZIP 中的核心文件是：

- `records.jsonl`：一行一条评价样本。
- `documents.json`：文档元信息和 hash，不包含全文。
- `manifest.json`：导出参数、schema version 和计数。

## 转成干净 CSV

项目内置了一个面向 Agent 的 Skill 和一个确定性脚本：

- Skill 位置：`docs/skills/annotation-training-csv/SKILL.md`
- 脚本位置：`docs/skills/annotation-training-csv/scripts/extract_training_csv.py`

默认 CSV 只输出四列，减少后续 LLM token 消耗：

```csv
id,comment,source_text,label
```

运行示例：

```bash
python3 docs/skills/annotation-training-csv/scripts/extract_training_csv.py \
  ~/Downloads/annotation-training-export.zip \
  training_data.csv \
  --only-training-candidates
```

脚本也可以直接读取解压后的目录或 `records.jsonl`：

```bash
python3 docs/skills/annotation-training-csv/scripts/extract_training_csv.py \
  ~/Downloads/annotation-training-export/records.jsonl \
  training_data.csv
```

如需审计来源，可以加 `--include-meta` 输出 `record_id`、文档名、章节、标签等追踪字段；训练用 CSV 建议保持默认最小列。

## 下载这个 Skill

如果要把这个 Skill 复制到其他项目，可以用 npm tooling 下载：

```bash
npm exec --yes degit OhMyYuwan/YuwanLabWriter/docs/skills/annotation-training-csv ./annotation-training-csv
```

如果仓库是 private，请先用 GitHub 身份 clone 仓库，再复制 `docs/skills/annotation-training-csv/`。
