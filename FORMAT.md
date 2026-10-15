# dsh-keepsake 记忆文件格式（FORMAT）

> 目标：dsh-keepsake 写出的记忆是**纯 markdown + YAML frontmatter**——人类可读、可进 git、可被其他 agent 直接复用。本页是该格式的唯一权威说明，也是跨 agent 互认的约定（见 ROADMAP）。字段口径与 `lib/global-store.js`（全局）、`lib/extract.js`（项目）的写盘实现一一对应。

## 一、文件布局

```
<storageRoot>/                     # 默认 ~/.dsh/memory
├── keepsake-format.json           # 存储格式版本标记（本插件内部用；见第八节）
├── extract.lock                   # 提取/恢复批互斥锁（插件自管，可安全删除；见第七节）
├── backups/  trash/               # 副本目录（非真源，可安全删除；见第七节）
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

- 行内链接目标 = 同目录下的文件名（统一小写 + `.md`；索引行链接与磁盘文件名**逐字节一致**，在大小写敏感文件系统上不致断链）；钩子尽量 ≤150 字符（超长会被 `clampIndexLine` 截断）。
- 索引由插件在落盘时自动合并维护（`mergeIndexContent`）；模型直写记忆时也应追加一行。

## 五、文件名

- kebab-case：由标题派生（`deriveEntryName`），经三道闸净化（仅 `[a-z0-9._-]`、去黑名单段、截长）；
- 显式给定的文件名（导入 / 面板 / 落盘）先归一化（强制小写 + 补 `.md`）；保留名、`../`、黑名单段等**非法名显式拒绝**，不再静默改名或拍扁；
- 重名自动 `-2` / `-3` 避让；
- 保留名（`MEMORY.md` 等）与嵌套路径被拒（`writeEntryDirect`）。

## 六、跨 agent 互认约定

本格式有意与常见 markdown 记忆约定对齐，使同一套记忆文件可被多个 agent 直接读取：

- **frontmatter 四字段**：`name` / `description` / `metadata.type` / `node_type` 三处同名同义；
- **互链语法**：`[[name]]`（悬空链接合法，指向尚未存在的条目）；
- **一行一事实**：条目粒度 = 一个可独立引用的断言/事实；
- **索引即目录**：`MEMORY.md` 的 `- [Title](file.md) — hook` 行是跨工具的统一导航格式。

> 约定变更（字段增删、语义调整）视为**对外契约变化**，按 ROADMAP 的版本纪律记入并同步本页。

## 七、`backups/` 与 `trash/` 是包外非真源目录

存储根下有两类**插件自留的副本目录**，它们**不是记忆真源**：

```text
<storageRoot>/
├── backups/<ts>/               # 批量破坏性操作前的全量备份（滚动保留最新 20 份）
│   └── surgical/<batchId>/     # 批前「手术式」快照：本批覆写/删除触及的原文留档
│       ├── manifest.json       # 批次清单（files[]：name / rootKey / sha1 / action / indexLine）
│       ├── files/              # 原文副本（按 rootKey 分目录）
│       └── failed/             # 写后校验失败的新档标本（不删，留待排查）
└── trash/<entryId>/            # 回收站：被删除的记忆文件（默认保留 30 天）
    ├── meta.json               # 条目清单（files[]：name / rootKey / sha1 / action / indexLine）
    └── files/                  # 原文副本
```

- **真源只有 `*.md` 与 `MEMORY.md`**：`global/<category>/*.md` 与 `projects/<slug>-<hash16>/memory/*.md` 才是记忆本身；每目录的 `MEMORY.md` 是导航索引。`settings.json`（开关）、`persona.md`（人设）、`addressing.json`（称呼）也是真源（各自唯一）。
- **`backups/` 与 `trash/` 可安全删除**：删掉它们**不损失任何当前记忆**——它们是历史副本，用于回滚。插件会在下次批量操作/删除时按需重建目录；`keepsake-format.json` 缺失同理会被补写（见第八节）。
- **删除的代价是失去后悔药**：清掉 `backups/` 就没有「恢复此备份 / 回滚快照」的入口；清掉 `trash/` 就等于把被删的条目**真正**删除（回收站的语义是"延迟删除"，不是归档）。注意回收站只收**自动提取**产生的删除；面板手动「删除条目」（`DELETE /entry`）与分类重置（`clearCategory`）、近期动态滚动清理（`pruneRecentActivity`）是直接删除、不进回收站。
- **`backups/surgical/` 与 `trash/` 都有自动清理**：快照按 `settings.surgicalKeep`（默认 30 份）滚动保留最新；回收站按 `settings.trashKeepDays`（默认 30 天）清过期。两者都由写入路径顺带收口，无需手工维护。
- **不要手工改 `manifest.json` / `meta.json`**：它们是盘上数据，恢复时按三道闸逐条校验（`name` / `rootKey` 都要过 `sanitizeMemoryName` 与 `rootDirOf`），改坏了最多是该条被跳过并告警——但没必要冒险。
- **跨 agent 互认不涉及这两类目录**：外部 agent 只读真源（`*.md` + `MEMORY.md`）即可；副本目录是本插件内部的可逆性设施，格式不对外承诺稳定。
- **`extract.lock` 是运行时锁文件（同样可安全删除）**：提取落盘与三类恢复端点（快照 / 回收站 / 整份备份）共用存储根下的 `extract.lock` 互斥——原子创建、stale 超时接管、用完即删。它不是记忆数据、也不进任何备份，**删掉不损失记忆**，只是放弃一次在途批次的互斥保护，下一批会自动重建。

## 八、存储格式版本（`keepsake-format.json`）

存储根下有一个 `keepsake-format.json`，记录**写这份数据的格式版本**：

```json
{ "formatVersion": 1 }
```

- **它不是记忆内容**（跨 agent 互认只认上面的 markdown 与索引），而是本插件的**升级/降级安全标记**。
- 语义：`formatVersion` = 写下这份数据的插件所理解的格式版本。插件启动时按存储根的标记判定：
  - **标记缺失**（v0.1/v0.2 的旧数据无此文件，或全新目录）→ 补写当前版本，正常读写；
  - **等于当前** → 正常；
  - **低于当前** → 未来的格式迁移入口（当前 `FORMAT_VERSION=1`，无更早版本），补写当前版本；
  - **高于当前** → 数据由**更新版**插件写入，本版本**自动转只读**：拒绝写入与滚动清理（写端点 503，门牌与面板健康卡显式报警），读取仍放行（非破坏性）。升级插件后自动恢复。
  - **标记损坏**（文件在但无法解析，如截断 / 非法 JSON）→ 无法判断版本，**先备份再补写**：把损坏文件改名为 `keepsake-format.json.corrupt-<时间戳>`，再补写当前版本——绝不静默覆盖（原标记可能记录着更高版本，是唯一的降级信号）。
- **格式版本没变，不代表能力没变**：`FORMAT_VERSION` 自 v0.3.0 起未再变化，所以从 v0.4.0 降级回旧版（如 v0.2.x）时格式闸**不会**触发——旧版可以正常读写同一份数据；但旧版没有 v0.4.0 的写入安全面（批前快照 / 回收站 / `sha1` 覆盖闸 / 写后读校验），其覆写是直接替换旧文。降级前建议先做一次全量备份（设置页「导出全部」或直接拷走 `<storageRoot>/`）。
- 该文件可安全删除（会被视为"缺失"并补写当前版本）；但删除它等于放弃降级保护，请仅在确认数据格式与当前插件一致时这么做。
- **破坏性格式变更（字段增删、语义调整）必须把 `FORMAT_VERSION` +1 并在迁移位登记**——这是对外契约变化，同步更新本页与 [ROADMAP.md](ROADMAP.md) 的版本纪律。

## 九、不做 / 预留

- **墓碑删除**（`deleted:` 元数据）**预留不实现**：本插件纯本地单机，暂无多端合并需求；为将来 git 同步/跨 agent 合并预留一个可选 `deleted` 字段位置即可（见 ROADMAP，不单独排批）。
- **不引入 JSON 真源**：本插件 markdown 即真源（区别于以 JSON 为真源、markdown 为渲染产物的方案），保证"用户能直接打开编辑"。
