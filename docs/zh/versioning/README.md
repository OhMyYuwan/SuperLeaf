---
title: 版本历史与项目归档
parent: 中文文档
nav_order: 8
---

# 版本历史与项目归档

SuperLeaf 有两层版本能力：单文档历史和项目大版本。它们解决的问题不同，不应该混在一起理解。

## 两层版本

| 层级 | 存储方式 | 用途 |
|---|---|---|
| 文档历史 | SQLite blob + `document_versions` | 查看某篇文档的历史、diff、恢复到旧版本 |
| 项目大版本 | 后端服务机器上的 git archive repo | 保存整个项目树的原子快照、对比、恢复、下载 ZIP、推送到 GitHub |

## 文档历史

文档历史面向单个 `.tex` / `.md` 文档。后端会保存文档内容快照，并支持：

- 列出历史版本。
- 查看版本内容。
- 计算两个版本之间的 diff。
- 给重要版本加标签。
- 以 append-only 方式恢复到历史内容。

恢复不会删除历史版本，而是把历史内容应用为当前内容并生成新的快照。

## 项目大版本

项目大版本面向整个项目树，包括文档、图片和上传文件。它使用服务器端 git archive 作为实现：

```text
~/.yuwanlab/archives/{project_id}/
```

这个路径在运行 Backend 的机器上，不等同于用户电脑里的本地 git 仓库。普通用户不需要进入这个目录操作。

项目大版本支持：

- 保存当前项目树为 commit。
- 与父 commit 对比。
- 恢复到某个 commit，并创建新的恢复 commit。
- 下载某个 commit 对应的完整项目 ZIP。
- 配置 GitHub 仓库并推送 archive branch。

{: .important }
项目大版本的恢复也是 append-only：恢复会创建一个新 commit，不会重写历史。

## 下载指定大版本

在 **版本 → 项目大版本** 中，每条 commit 都有 **下载** 按钮。下载内容是该 commit 时刻的完整项目文件 ZIP。

适合场景：

- 交付某个稳定版本给合作者。
- 离线备份项目某一刻的完整文件树。
- 对比恢复前先下载历史版本自查。

## GitHub 归档仓库

GitHub 绑定只保存用户提供的仓库地址和 branch。SuperLeaf 不会自动创建仓库、修改仓库可见性或创建 PR。

默认 branch 名仍保留 `yuwanlab-archive`，这是运行时兼容名，不需要因为产品名改为 SuperLeaf 而修改。

## 和 Git 的关系

底层用 git 是为了得到可靠的原子快照、diff、restore 和 archive 能力。但 UI 暴露的是“项目归档版本”，不是完整 Git 客户端。

如果未来要支持分支、tag、PR 或用户本地仓库同步，应该作为独立功能设计，而不是混入当前大版本面板。
