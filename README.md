# dsh-keepsake

[![CI](https://github.com/axuan-1314/dsh-keepsake/actions/workflows/ci.yml/badge.svg)](https://github.com/axuan-1314/dsh-keepsake/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **[English](README.en.md) | 中文**

一个给 DSH（DeepSeek Harness）用的记忆插件。你跟它聊过的事，它自己记下来，下次开新对话不用再把背景讲一遍。

![记忆管理面板](docs/panel.png)

## 它解决什么问题

DSH 每开一个新会话都是从零开始。上周定的接口口径、这个项目的目录约定、你说过一次就不想再说第二次的偏好——都得重新交代。

这个插件在后台做三件事：

- **记**：每轮对话结束，它判断这轮有没有值得记的事，有就写成本地 Markdown 文件。
- **带**：之后每轮对话自动把相关记忆塞回上下文，模型就"记得"你了。
- **管**：附一个本地面板，记了什么、删了什么、人设怎么设，都能看能改。

记忆存在 `~/.dsh/memory/` 下的普通 Markdown 文件里，你可以用任何编辑器打开、改、丢进 git。不上传任何地方。

## 安装

```bash
dsh plugin --profile web add "https://github.com/axuan-1314/dsh-keepsake/archive/refs/tags/v0.7.0.tar.gz"
```

`--profile` 换成 `headless` 或 `desktop` 也行。零运行时依赖，不需要 `npm install`。

想装含未发布内容的版本，把 tag 换成 `heads/main`：`.../archive/refs/heads/main.tar.gz`。

装完开个新会话正常聊几轮有实质内容的话，然后看 `~/.dsh/memory/` 下有没有出现新的 `.md` 文件。详细步骤和升级方式见 [安装与升级](docs/install.md)。

面板入口在 DSH 设置页的「记忆」区块。

## 最近改了什么

v0.7.0 之后（仓库 `main`，尚未打 tag）是一批较大的功能补充和修复：

- **纠错闭环**：以前记忆记错了只能等下次提取碰巧覆盖，常留下两条互相矛盾的事实。现在可以说"这条记错了，正确的是 X"——对话里用 `/memory fix`，或在面板检索后点「纠正这条」。改动有快照，能回滚。
- **`/memory` 命令**：关键词检索记忆，不用开面板。
- **记忆整理**：面板给出重复条目、久未更新的条目、索引与磁盘对不上的地方；一键修索引只动索引行，不删条目。
- **项目知识页**：把一个项目的记忆压缩成 5 页稳定视图（组件地图、核心概念、约定、关键决策、进行中），手动生成，不自动烧钱。
- **空闲整理**（默认关）：空闲时让模型合并重复、清理过期的项目记忆。
- **面板看得清了**：面板底色改自持实色。此前壁纸插件把背景改成半透明白时，白字压在浅灰上实测只有 3.10:1，卡片和正文同色没有边界。
- **纠错不再"改一半"**：纠错写入原先每次都退化成"追加"，盘上留下新旧两条矛盾事实。已修。

完整历史见 [CHANGELOG.md](CHANGELOG.md)；已知限制和有意不做的功能见 [ROADMAP.md](ROADMAP.md)。

## 功能一览

| 功能 | 默认 | 一句话 |
|---|---|---|
| 自动提取 + 注入 | 开 | 聊完自动记，下轮自动带上 |
| 记忆管理面板 | — | 浏览 / 编辑 / 删除 / 导入导出 / 人设 / 回收站 / 快照 |
| 内容脱敏 | 开 | 密钥、令牌、内网地址不进记忆和提示词 |
| 运行时记忆层 | 关 | 把条目编译成定长画像，每轮常驻，不用等模型主动查 |
| 语义召回 | 关 | 按你当前问题做向量检索，带出最相关的几条 |
| 项目知识页 | 手动 | 一个项目压成 5 页视图 |
| 空闲整理 | 关 | 空闲时合并重复、清理过期 |
| 纠错闭环 | — | "这条错了"有一条正式通道，可回滚 |

每一项的细节——怎么触发、失败会怎样、怎么关掉——见 [功能详解](docs/features.md)。

## 配置

大部分人在面板里点点就够了，不用碰配置文件。需要改 `cordis.patch.yml` 的场合主要是三件：指定提取用哪个模型、调注入预算、配语义召回端点。

几个常改的键：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | 跟随会话路由 | 提取用的模型，成对出现 |
| `injectMaxChars` | 30000 | 注入字符预算 |
| `injectMaxTokens` | 24000 | 注入 token 预算（0 = 关闭） |
| `redactionEnabled` | `true` | 脱敏总开关 |
| `recallEnabled` | `false` | 语义召回开关 |

全部配置项见 [配置参考](docs/configuration.md)。

## 数据在哪

```
~/.dsh/memory/
├── global/                    # 全局记忆（跨对话）
│   ├── persona.md             # 人设
│   └── work-profile/ ...      # 四个分类，每类一个索引 + 若干条目
├── projects/<项目>/memory/    # 项目记忆（按工作区隔离）
├── runtime/                   # 运行时记忆产物（可删可重建）
├── pages/                     # 知识页（可删可重建）
├── backups/                   # 自动备份
└── trash/                     # 回收站
```

真源只有 `*.md` 和 `MEMORY.md`；`backups/`、`trash/`、`runtime/`、`pages/` 都是副本或派生视图，删了不损失记忆（只失去回滚能力）。

完整布局与文件格式见 [FORMAT.md](FORMAT.md)。

**隐私**：所有数据留在本机。提取调用走你当前会话的模型通道，没有另外的上传路径。API 和面板只监听 loopback。失败日志只记错误摘要，不含会话内容。

## 文档

| 文档 | 内容 |
|---|---|
| [安装与升级](docs/install.md) | 安装、升级、验证生效、卸载与回滚 |
| [功能详解](docs/features.md) | 每项功能的触发条件、边界行为、开关 |
| [配置参考](docs/configuration.md) | 全部配置键与默认值 |
| [运维与 API](docs/operations.md) | 观测字段、REST 端点、排障 FAQ |
| [FORMAT.md](FORMAT.md) | 记忆文件格式、目录约定、存储格式版本 |
| [RUNTIME-FORMAT.md](RUNTIME-FORMAT.md) | 运行时记忆层格式 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [ROADMAP.md](ROADMAP.md) | 设计原则、已知限制、有意不做 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境与 PR 约定 |

## 开发

```bash
npm test        # node --test，全部单元测试
npm run check   # lib/*.js 语法快检
```

零依赖，clone 下来直接能跑，不需要 install。

## 相关项目

同作者的另一个 DSH 插件，互不依赖：[dsh-usage-stats](https://github.com/axuan-1314/dsh-usage-stats)（使用统计：Token 热力图、趋势、模型占比）。

## License

[MIT](LICENSE)
