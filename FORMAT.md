# dsh-memory 记忆文件格式（FORMAT）

> 目标：dsh-memory 写出的记忆是**纯 markdown + YAML frontmatter**——人类可读、可进 git、可被其他 agent 直接复用。本页是该格式的唯一权威说明，也是跨 agent 互认的约定（见 ROADMAP）。字段口径与 `lib/global-store.js`（全局）、`lib/extract.js`（项目）的写盘实现一一对应。

## 一、文件布局

```
<storageRoot>/                     # 默认 ~/.dsh/memory
├── global/                        # 全局记忆（跨所有会话）
│   ├── persona.md                 # 人设（出厂默认模板起步）
│   ├── addressing.json            # 称呼 {dshName, userAlias}
│   └── <category>/                # 五个分类目录
│       ├── MEMORY.md              # 该分类索引
│       └── <kebab-name>.md        # 记忆条目
└── projects/<slug>-<hash16>/      # 项目记忆（按工作区路径隔离）
    └── memory/
        ├── MEMORY.md              # 项目索引
        └── <kebab-name>.md        # 记忆条目
```

- 全局分类 `<category>` ∈ `work-profile` / `user-profile` / `current-focus` / `recent-activity` / `long-term`。
- `<slug>` = workspace basename 净化（小写、`[^a-z0-9._-]+`→`-`、截 48、空则 `project`）；`<hash16>` = 绝对路径（win32 转小写）sha256 前 16 hex。

## 二、frontmatter

**项目记忆**（`<slug>-<hash16>/memory/*.md`）：

```yaml
---
name: "uses-pnpm"
description: "团队统一用 pnpm 管理依赖"
metadata:
  type: project        # user | feedback | project | reference
node_type: "memory"
originSessionId: "s-xxxx"
---
<正文>
```

**全局记忆**（`global/<category>/*.md`）：

```yaml
---
name: "release-checklist"
title: "发布检查清单"
description: "上线前必做的几步"
metadata:
  type: global
  timestamp: "2026-10-13T05:00:00.000Z"   # 仅 recent-activity：宿主盖章，不信模型报的时间
node_type: "memory"
---
<正文>
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 条目标识（通常 = 文件名去 `.md`） |
| `title` | 全局 | 展示标题（全局记忆用；项目记忆以 `name` 兼作标题） |
| `description` | 是 | 一行钩子，进索引行（≤150 字符提示）；也是语义召回的嵌入文本之一 |
| `metadata.type` | 是 | 见下「类型」；全局记忆恒为 `global` |
| `metadata.timestamp` | 仅 recent-activity | ISO 时间，**宿主盖章**（不信模型） |
| `node_type` | 是 | 恒 `"memory"`（跨库识别用的稳定标记） |
| `originSessionId` | 项目 | 产出该条目的会话 id（可追溯） |

**类型（`metadata.type`，项目记忆）**：

- `user`——用户是谁（身份、偏好）；
- `feedback`——该如何行事（含 `Why:` 与 `How to apply:`）；
- `project`——本项目决策与状态（缺省）；
- `reference`——外部指针（URL、工单）。

## 三、正文

frontmatter 之后的全部内容即正文（首个 `---` 块之后）。一个文件一条事实，标题可选（建议首行是 `# 标题`）。

## 四、索引（`MEMORY.md`）

每目录一个索引，一行一条：

```
- [Title](file.md) — one-line hook (≤150 chars)
```

- 行内链接目标 = 同目录下的文件名；钩子尽量 ≤150 字符（超长会被 `clampIndexLine` 截断）。
- 索引由插件在落盘时自动合并维护（`mergeIndexContent`）；模型直写记忆时也应追加一行。

## 五、文件名

- kebab-case：由标题派生（`deriveEntryName`），经三道闸净化（仅 `[a-z0-9._-]`、去黑名单段、截长）；
- 重名自动 `-2` / `-3` 避让；
- 保留名（`MEMORY.md` 等）与嵌套路径被拒（`writeEntryDirect`）。

## 六、跨 agent 互认约定

本格式有意与常见 markdown 记忆约定对齐，使同一套记忆文件可被多个 agent 直接读取：

- **frontmatter 四字段**：`name` / `description` / `metadata.type` / `node_type` 三处同名同义；
- **互链语法**：`[[name]]`（悬空链接合法，指向尚未存在的条目）；
- **一行一事实**：条目粒度 = 一个可独立引用的断言/事实；
- **索引即目录**：`MEMORY.md` 的 `- [Title](file.md) — hook` 行是跨工具的统一导航格式。

> 约定变更（字段增删、语义调整）视为**对外契约变化**，按 ROADMAP 的版本纪律记入并同步本页。

## 七、不做 / 预留

- **墓碑删除**（`deleted:` 元数据）**预留不实现**：本插件纯本地单机，暂无多端合并需求；为将来 git 同步/跨 agent 合并预留一个可选 `deleted` 字段位置即可（见 ROADMAP，不单独排批）。
- **不引入 JSON 真源**：本插件 markdown 即真源（区别于以 JSON 为真源、markdown 为渲染产物的方案），保证"用户能直接打开编辑"。
