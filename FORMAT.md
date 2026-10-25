# dsh-keepsake 记忆文件格式（FORMAT）

> 目标：dsh-keepsake 写出的记忆是**纯 markdown + YAML frontmatter**——人类可读、可进 git、可被其他 agent 直接复用。本页是该格式的唯一权威说明，也是跨 agent 互认的约定（见 ROADMAP）。字段口径与 `lib/global-store.js`（全局）、`lib/extract.js`（项目）的写盘实现一一对应。

## 一、文件布局

```
<storageRoot>/                     # 默认 ~/.dsh/memory
├── keepsake-format.json           # 存储格式版本标记（本插件内部用；见第八节）
├── extract.lock                   # 提取/恢复批互斥锁（插件自管，可安全删除；见第七节）
├── extraction-journal.jsonl       # 提取运行日志（观测+续提边界，非真源，可安全删除；见第七节）
├── extraction-journal.jsonl.abandoned-truncated.json  # 放弃计数 sidecar（日志轮转裁掉的条数；与主档同生命周期）
├── runtime/                       # 运行时记忆层编译产物（USER.md/MEMORY.md + runtime.json + compile-journal.jsonl；非真源，可删可重建；见第七节）
├── evict-audit.jsonl              # 淘汰归档审计（持久记录，不随 runtime/ 清理；非真源，见第七节）
├── backups/  trash/               # 副本目录（含 backups/evict-<ts>/ 归档前手术式快照；非真源，可安全删除；见第七节）
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
- `runtime/`、`evict-audit.jsonl`、`backups/evict-<ts>/` 都是**编译/归档设施的派生产物**，不是记忆真源：`runtime/` 整目录可删可重建（丢的只是编译观测历史）；`evict-audit.jsonl` 是持久审计记录（删除丢的是可追溯性）；`backups/evict-<ts>/` 只快照归档搬动的文件（见第七节）。

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
| `pinned` | 可选 | `true` = 关键条目（运行时记忆层不淘汰、优先入选）。全局与项目条目皆可；缺省/`false` 即非 pinned。格式 v2 起（见第八节） |
| `node_type` | 是 | 恒 `"memory"`（跨库识别用的稳定标记） |
| `originSessionId` | 项目 | 产出该条目的会话 id（可追溯） |

**`pinned`（格式 v2 新增，可选布尔）**：写在**顶层**（不缩进），字段序紧随 `metadata` 块之后、`node_type` 之前，只在为真时写出：

```yaml
metadata:
  type: global
pinned: true
node_type: "memory"
```

读者口径宽容：`"true"` 与 `true` 皆视为真，缺失、`false` 及其他值一律视为非 pinned。它是运行时记忆层（编译产物）的选条依据，**不影响**本节其余字段的固定语义。

**long-term 可选 origin 三字段（格式 v2 新增）**：`global/long-term/` 里的条目由淘汰归档写入时，额外携带出处，全部可选：

- `originProject`——来源项目（形如 `projects/<slug>-<hash16>`）；全局条目归档时省略。
- `originType`——原 `metadata.type`（`project` / `feedback` / `user`）或原全局分类名。
- `originSessionId`——原条目的 `originSessionId` 原样透传。

三字段只服务「从归档移回」的可逆性；普通读者忽略它们不损失任何信息（向后兼容，旧条目没有这三个字段也完全合法）。

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

`pinned` 与运行时记忆层编译产物的行前缀（`【关键】`/`【普通】`）**不参与跨 agent 互认**：前者是本插件的可选扩展字段（读不懂时按非 pinned 处理即可），后者只出现在本插件生成的产物里，回退到真源（条目文件 + `MEMORY.md`）即可获得完整语义。

## 七、`backups/`、`trash/`、`runtime/`、`pages/`、`correction-ledger.jsonl` 是包外非真源目录

存储根下有多类**插件自留的非真源目录**，它们**不是记忆真源**：

```text
<storageRoot>/
├── backups/<ts>/               # 批量破坏性操作前的全量备份（滚动保留最新 20 份）
│   ├── surgical/<batchId>/     # 批前「手术式」快照：本批覆写/删除触及的原文留档
│   │   ├── manifest.json       # 批次清单（files[]：name / rootKey / sha1 / action / indexLine）
│   │   ├── files/              # 原文副本（按 rootKey 分目录）
│   │   └── failed/             # 写后校验失败的新档标本（不删，留待排查）
│   └── evict-<ts>/<n>-<name>   # 淘汰归档前的手术式快照（只快照被搬文件；保留最近 10 份）
├── trash/<entryId>/            # 回收站：被删除的记忆文件（默认保留 30 天）
│   ├── meta.json               # 条目清单（files[]：name / rootKey / sha1 / action / indexLine）
│   └── files/                  # 原文副本
├── pages/<projectId>/          # 项目知识页（派生视图，整目录可删可重建）
│   ├── manifest.json           # 生成时间 / 来源指纹 / 五页摘要
│   └── <page-id>.md            # 五页正文（component-map / core-concepts / conventions / key-decisions / initiatives）
├── runtime/                    # 运行时记忆层编译产物（非真源，整目录可删可重建）
│   ├── global/                 # 每个 scope 一份：USER.md / MEMORY.md / runtime.json
│   ├── projects/<slug>-<hash16>/
│   └── compile-journal.jsonl   # 编译观测日志（滚动清理）
├── correction-ledger.jsonl     # 纠错记录（审计面，非真源；1000 行轮转留尾 500）
└── evict-audit.jsonl           # 淘汰归档审计（持久记录，不随 runtime/ 清理；5000 行轮转留尾 2500）
```

- **真源只有 `*.md` 与 `MEMORY.md`**：`global/<category>/*.md` 与 `projects/<slug>-<hash16>/memory/*.md` 才是记忆本身；每目录的 `MEMORY.md` 是导航索引。`settings.json`（开关）、`persona.md`（人设）、`addressing.json`（称呼）也是真源（各自唯一）。
- **`backups/`、`trash/`、`runtime/`、`evict-audit.jsonl`、`correction-ledger.jsonl` 都是非真源**：删掉它们**不损失任何当前记忆**——`backups/` 与 `trash/` 是历史副本（用于回滚）；`runtime/` 是编译产物（下次编译自动重建）；`evict-audit.jsonl` 是归档执行审计（删除只丢可追溯性）；`correction-ledger.jsonl` 是纠错审计（删除只丢「哪次纠错改了什么」的追溯，纠错本身已落进条目与快照）。`keepsake-format.json` 缺失同理会被补写（见第八节）。
- **删除的代价是失去后悔药**：清掉 `backups/` 就没有「恢复此备份 / 回滚快照」的入口；清掉 `trash/` 就等于把被删的条目**真正**删除（回收站的语义是"延迟删除"，不是归档）；清掉 `evict-audit.jsonl` 就查不到某条何时、被谁、从哪归档到哪。**面板手动「删除条目」（`DELETE /entry`）与自动提取产生的删除同口径，都移入回收站**（v0.4.1 起；此前是直接删除）。分类重置（`clearCategory`）与近期动态滚动清理（`pruneRecentActivity`）仍是直接删除、不进回收站。
- **`backups/surgical/`、`backups/evict-*` 与 `trash/` 都有自动清理**：快照按 `settings.surgicalKeep`（默认 30 份）滚动保留最新；归档快照保留最近 10 份；回收站按 `settings.trashKeepDays`（默认 30 天）清过期。三者都由写入/归档路径顺带收口，无需手工维护。
- **不要手工改 `manifest.json` / `meta.json`**：它们是盘上数据，恢复时按三道闸逐条校验（`name` / `rootKey` 都要过 `sanitizeMemoryName` 与 `rootDirOf`），改坏了最多是该条被跳过并告警——但没必要冒险。
- **跨 agent 互认不涉及这些非真源目录**：外部 agent 只读真源（`*.md` + `MEMORY.md`）即可；副本/产物目录是本插件内部的可逆性与编译设施，格式不对外承诺稳定。
- **`extract.lock` 是运行时锁文件（同样可安全删除）**：提取落盘与三类恢复端点（快照 / 回收站 / 整份备份）共用存储根下的 `extract.lock` 互斥——原子创建、stale 超时接管、用完即删。它不是记忆数据、也不进任何备份，**删掉不损失记忆**，只是放弃一次在途批次的互斥保护，下一批会自动重建。
- **`extraction-journal.jsonl` 是提取运行日志（同样可安全删除）**：每次提取结算（写了几条 / 无可记 / 跳过 / 失败）落一行，是面板"最近提取记录"与"未恢复区间"提示的数据源；每会话提取覆盖边界（cursor）也随它持久化，DSH 重启后据此从上次边界续提。它不是记忆真源——**删掉不损失任何记忆**，代价是丢掉提取观测历史与跨重启续提边界（此前失败未补的区间会因此补不回来），之后的提取照常重新开张。文件自带滚动清理（超 2000 行留尾 1000），无需手工维护。

  同目录还有个 `extraction-journal.jsonl.abandoned-truncated.json`（sidecar）：记「被轮转裁掉了多少条 abandoned 行」，用来让面板「已放弃 N 轮」跨重启不缩水。它**与主档同生命周期**——主档不存在时会被视为过期并自动清理，所以按本节说明删主档不会留下幽灵计数。
- **`pages/` 是项目知识页的派生视图（非真源，整目录可删可重建）**：`pages/<projectId>/<page-id>.md` 由项目条目经一次手动 LLM 调用合成，`manifest.json` 记生成时间 / 来源指纹 / 五页摘要。它不是记忆真源——删掉只丢派生页面，条目与索引不受影响；重新生成即可恢复。注入侧只读 manifest 摘要（标题 + 一行钩子 + 路径），不注入页面全文；记忆索引变化后摘要会标 `[stale]`，提示重新生成。
- **`runtime/` 是运行时记忆层的编译产物（非真源，整目录可删可重建）**：`runtime/<scope>/USER.md`、`MEMORY.md` 由条目**编译**而来（每 scope 一份，内容 = 全局条目 + 该项目条目），`runtime.json` 是编译清单（选条 / 淘汰候选 / 状态），`runtime/compile-journal.jsonl` 是编译观测日志（达 2000 行轮转留尾 1000）。它们全部可删——**删掉不损失任何记忆**，代价只是丢编译观测历史与编译缓存，下一次注入/面板打开时自动重建。手工修改产物会在下次编译时被覆盖；编辑请回到条目文件。
- **`evict-audit.jsonl` 是淘汰归档的持久审计记录（非真源）**：每次「执行归档」追加一行（时间 / scope / 原位置 / 新位置 / 快照目录 / 操作者）。它**不随 `runtime/` 删除**，是「某条何时被归档到哪」的唯一凭证；达 5000 行轮转留尾 2500（「持久」指不随 `runtime/` 清理，非无限增长）。删掉不损失任何记忆，只丢可追溯性。
- **`backups/evict-<ts>/` 是归档前的手术式快照**：只复制被搬文件（不做全量导出），保留最近 10 份；用于误归档时精确还原。

## 八、存储格式版本（`keepsake-format.json`）

存储根下有一个 `keepsake-format.json`，记录**写这份数据的格式版本**：

```json
{ "formatVersion": 2 }
```

- **它不是记忆内容**（跨 agent 互认只认上面的 markdown 与索引），而是本插件的**升级/降级安全标记**。
- 语义：`formatVersion` = 写下这份数据的插件所理解的格式版本。插件启动时按存储根的标记判定：
  - **标记缺失**（v0.1/v0.2 的旧数据无此文件，或全新目录）→ 补写当前版本，正常读写；
  - **等于当前** → 正常；
  - **低于当前** → 在迁移位逐版登记迁移后补写当前版本。**v1 → v2（2026-10-20）**：新增可选 `pinned` 与 long-term 可选 origin 三字段（第二节），均为可选增量字段，**无数据迁移**——旧条目缺省即「非 pinned / 无出处」，启动时只补写 `formatVersion:2` 标记，不改写任何文件；
  - **高于当前** → 数据由**更新版**插件写入，本版本**自动转只读**：拒绝写入与滚动清理（写端点 503，门牌与面板健康卡显式报警），读取仍放行（非破坏性）。升级插件后自动恢复。v2 起这也覆盖「旧版插件读 v2 数据」场景——旧版读不懂 `pinned`，转只读后不会在覆写时把 pin 剥掉；
  - **标记损坏**（文件在但无法解析，如截断 / 非法 JSON）→ 无法判断版本，**先备份再补写**：把损坏文件改名为 `keepsake-format.json.corrupt-<时间戳>`，再补写当前版本——绝不静默覆盖（原标记可能记录着更高版本，是唯一的降级信号）。
- **格式版本没变，不代表能力没变**：v0.3.0 → v0.5.0 期间 `FORMAT_VERSION` 一直为 1，所以从 v0.4.0/v0.5.0 降级回旧版（如 v0.2.x）时格式闸**不会**触发——旧版可以正常读写同一份数据；但旧版没有 v0.4.0 的写入安全面（批前快照 / 回收站 / `sha1` 覆盖闸 / 写后读校验），其覆写是直接替换旧文。降级前建议先做一次全量备份（设置页「导出全部」或直接拷走 `<storageRoot>/`）。
- 该文件可安全删除（会被视为"缺失"并补写当前版本）；但删除它等于放弃降级保护，请仅在确认数据格式与当前插件一致时这么做。
- **破坏性格式变更（字段增删、语义调整）必须把 `FORMAT_VERSION` +1 并在迁移位登记**——这是对外契约变化，同步更新本页与 [ROADMAP.md](ROADMAP.md) 的版本纪律。

## 九、不做 / 预留

- **墓碑删除**（`deleted:` 元数据）**预留不实现**：本插件纯本地单机，暂无多端合并需求；为将来 git 同步/跨 agent 合并预留一个可选 `deleted` 字段位置即可（见 ROADMAP，不单独排批）。
- **不引入 JSON 真源**：本插件 markdown 即真源（区别于以 JSON 为真源、markdown 为渲染产物的方案），保证"用户能直接打开编辑"。
