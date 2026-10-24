# dsh-keepsake 路线图（ROADMAP）

> 日期：2026-10-22。
> 本文是 dsh-keepsake 的**公开路线图**：记录设计原则、已发布版本与下一版方向。
> 一句话定位：做一个**本地优先**的 DSH 记忆插件——纯 markdown 落盘、可进 git、零运行时依赖、失败显式可见。

## 设计原则

- **本地优先**：全部数据落在 `~/.dsh/memory/`，默认不出本机；API 与面板仅 loopback 可访问。
- **零运行时依赖**：只用 Node 内建模块，`clone` 下来无需安装即可运行。
- **失败不许静默**：降级、拒绝、日志三选一，且可观测（`/state` + 面板健康卡）。
- **可回滚**：每个开关都有退回路径，且默认态保守。

## 版本

| 版本 | 内容 | 状态 |
|---|---|---|
| **v0.6.4（已实现）** | 上两批修复自身引入的缺陷 + 五路独立检查 P2/P3 收尾（12 项）：**脱敏后 name 撞名导致误删/合并无关记忆**（改追加源名短指纹，单射映射）；**索引终态按 op 意图而非执行结果判定**（delete 被闸拦仍剔索引行 → 记忆静默消失；改为只看真成功执行的那次）；非 pinnedOver 提示行静默丢弃、`abandoned` sidecar 幽灵计数、`retired-*` 永久垃圾（成功恢复时清历史）、全局同批双写绕过 block、`backups/` 原子写 tmp 漏扫、空目录误报完整性未确认、`clipLinesToChars` 判据漏形态 + 提示行不计预算、日期式命名被当孤儿删。测试：补 memo 链路端到端行为测试（此前三种退化全部通过）。`FORMAT_VERSION` 仍为 2 | 已实现（v0.6.4） |
| **v0.6.3（已实现）** | P2/P3 收尾批（9 项）：同批两侧手术快照互杀（`protectIds` 豁免）；备份恢复半途态丢全局回滚材料（清理挪到两段成功后）；启动清扫误删他实例在途 tmp（改到龄判据）；`<名>.tmp-notes.md` 不再被当孤儿删（精确命名判据）；单行超长挤掉同类索引行时留可见提示；`redactOps` 覆盖 `name`（密钥不再能写进文件名）；`abandoned` 行封顶 200 + 计数 sidecar；`firstSeenAt` → `lastSeenAt`（名实相符）；面板「尚未编译」文案不再像报错。测试：`writeEntryDirect` origin 补 2 条、`runtimeMemo.clear` 改行为测试、删 1 条恒真死断言（`compile-journal` 检查改真实断言）。`FORMAT_VERSION` 仍为 2 | 已实现（v0.6.3） |
| **v0.6.2（已实现）** | 五路独立复查后的修复批（含测试自证式审查与 0.6.1 修复真实性独立复查）：同批 `delete→write` 同名条目导致索引行被清空、记忆对注入面静默消失（终态改按「最后一次出现的 action」判定）；全局四分类覆盖写缺硬事实比对（数字改错零留痕、`hardfactDrops` 恒 0、`block` 不生效）；嵌套条目 `frontmatter.name` 被展平制造幽灵文件与双份记忆（改为保留真实相对路径，写后校验 `expectedName` 同口径）；pinned 撑爆配额时淘汰候选 reason 误导（新增 `pinned-overflow`，面板指向「先解 pin」）+ 该场景下淘汰提示行被静默丢弃；`compile`/`compile-all` 不清进程内 memo（点「重新编译」后 2 秒内注入仍拿旧产物）；`renderMemoryFile` 的 `\r` 转义漏改（0.6.1 订正）；索引重建失败被静默吞掉。测试：修掉一条自证式回归测试（只读态 stale 清单用例走不到被测分支）、补上配额预留测试（10 组边界扫描）。无新增开关、`FORMAT_VERSION` 仍为 2 | 已实现（v0.6.2） |
| **v0.6.1（已实现）** | 运行时记忆层缺陷修复批（三轮复查 + 逐条实测复现 + 拆改验证）：pin/evict/restore 后写后二次全失效删掉刚编产物（面板随即 404）；被淘汰条目两头不可见（产物加 `[runtime evicted: N …]` 行 + globalIndex 改**分类粒度**去重 + 项目条目按已进产物剔行）；候选池读失败被当「分类空了」静默清空（只吞 ENOENT，其余 → `status=error` 保留上一版产物）；`/state.settings` 缺 `runtimeEnabled` 致面板开关谎报；归档条目 origin 三字段被普通编辑剥掉、手工移入 long-term 也不记出处（移回恒 400）；归档审计失败时余下候选静默失踪（改为动守卫在循环最前，源文件不动，如实回报）；淘汰提示行计入配额（超出先降短行、记忆优先于提示）；只读态按指纹校验避免陈旧清单整类去重；pin 端点补提取批互斥锁；section 模式 usage 判据补 `projectMemory`；极小预算不发零内容/只剩省略号的空壳块；面板展示归档半完成态明细。无新增开关、`FORMAT_VERSION` 仍为 2、无数据迁移。**注：本版 CHANGELOG 原称「11 项变异全部被抓住（0 存活）」，2026-10-22 复查实测 3 项存活，已在 v0.6.2 补齐测试** | 已实现（v0.6.1） |
| **v0.6.0（已实现）** | 运行时记忆层（默认关，`runtimeEnabled` 走 `settings.json`）：条目编译成定长 `runtime/<scope>/USER.md`（≤4KB）/ `MEMORY.md`（≤10KB）+ `runtime.json` 清单（选条 / 淘汰候选 / `status` / `sourceHash`），随每轮注入（注入由四段变六段，persona/runtimeUser/runtimeMemory 为锁定段）；`pinned` frontmatter 优先入选、合计超配额 `overQuota` 可见告警；淘汰走「编译登记候选 + 面板确认归档」（锁 + 手术式快照 `backups/evict-*` + 持久审计 `evict-audit.jsonl` + 长记忆 origin 三字段 + 可移回）；面板「运行时记忆」页签 + runtime API 六端点 + `compile-journal.jsonl`；行为变化：long-term 退出注入索引、persona 上限 16000→8000 字符、`injectMaxTokens` 默认 16000→24000、`FORMAT_VERSION` 1→2（旧版读到自动只读） | 已实现（v0.6.0） |
| **v0.5.0（已实现）** | 安全与成本收敛：内容脱敏（默认开，两道位置——提取提示词前 + 落盘前；内置 7 类固定模式，占位符 `[redacted]`，幂等；`redactionEnabled` 可关）+ 失败区间自动补提收口（默认开：会话关闭 / 轮次完成 / 启动清扫三触发面；只补 failed、abandoned 不自动重试；冷却 `autoRecoverCooldownMs` 默认 5 分钟；与手动按钮单飞互斥；`/state.recover` 增 auto* 四键）+ 注入 token 预算（`injectMaxTokens` 默认 16000、0=关，CJK 感知估算，与 `injectMaxChars` 双上限取严；召回块计入、主块让位；`/state.injection` 增 `lastTokens`/`totalTokens`，面板显示「最近 ≈X tokens / 上限 Y」）+ 提取触发门槛（打分门默认开、阈值 6：分数 = 用户词数 + 2×工具种类 + 2×真人轮次，不过门记 `skipped/thin-evidence`；空闲延迟默认 3000ms、0=立即，合并突发轮次、dispose flush 不丢；每会话上限默认 50、0=不限，只拦自动链路不碰手动补提；`/state.extractionConfig` 增五键）+ 样例 `injectMaxChars` 60000→30000 修漂移 | 已实现（v0.5.0） |
| **v0.4.2（已实现）** | 注入同源替换（块首取代声明 + 变更节流 + `/state.injection.throttled`/`superseded` 观测，`injectMaxChars` 默认下调至 30000）+ 会话补提（面板逐条重跑未恢复/已放弃区间，超范围显式拒绝；`GET /sessions/pending`、`POST /sessions/recover` 202 异步、`/state.recover` 观测）+ 记忆整理建议（重复 / 久未更新 / 索引对账与「修复索引」，只动索引行、改前留快照；`GET /maintenance/suggestions`、`POST /maintenance/repair-index`）+ 防自食判据泛化（任意插件注入与 instruction/summary/tool 系统性消息一律按机器来源排除，真人消息含 steer/followup 永远算数）；提取日志轮转按留痕价值裁剪（skipped 先裁、failed/abandoned 优先保留）、出列判据收紧为整段覆盖；面板体验补齐（列表分页、焦点陷阱、alert 角色、设置诊断黄条） | 已实现（v0.4.2） |
| **v0.4.1（已实现）** | 提取观测与续提：新增提取运行日志 `<storageRoot>/extraction-journal.jsonl`（每次结算留痕：written / zero-ops / skipped / failed / abandoned；超 2000 行轮转留尾 1000）+ cursor 随日志持久化、DSH 重启后**跨重启续提** + `/state.extractionLog`（`runs` / `unrecovered` / `abandoned`）+ 面板健康卡「最近提取记录」与「未恢复区间」红条双源、放弃区间留痕；安全面收口：面板手动保存条目**覆盖前留档**（成功响应带 `preSaveSnapshotId`）、`run_code` 里直写记忆目录的轮次也识别为直写轮并补 run_code 识别；设置页「保留策略」卡（回收站保留天数 / 快照保留份数 / 近期动态保留天数） | 已实现（v0.4.1） |
| **v0.4.0（已实现）** | 写入安全面（可逆性）：项目侧批前手术式快照 + 回收站（延迟删除，先落副本后删原件）+ 写后读校验（失败回滚、标本留档）+ 硬事实丢失告警（判据收窄为数字 / 版本号 / 十六进制标识 / 字节尺寸，剥 frontmatter、排除日期与倒计时注记；默认 warn、可 block）+ `sha1` 覆盖闸 + 盲写降级为追加 + 提取批锁；全局侧覆盖既有条目前自动快照（失败则跳过该覆盖）、删除入回收站；恢复端点加锁、恢复前对现存冲突文件留快照、恢复失败保留 retired 目录；安全面三项设置（`surgicalKeep` / `trashKeepDays` / `hardfactPolicy`）与 `/state.safety` 十字段观测；settings 分字段保真合并、回收站清理参数 400 校验；面板新增「快照」「回收站」两页与健康卡安全面摘要；备份补 project | 已实现（v0.4.0） |
| **v0.1.x** | 四段 systemPrompt 注入 + 记忆管理面板/门牌 + 提取韧性链（重试 / 失败分类 / 失败落盘日志 / 手动补提） | 已发布 |
| **v0.2.0** | 注入迁到 **durable 用户消息通道**（对所有预设生效，根治极简预设下的静默失忆；`injectChannel: "section"` 一键回退）+ 换道兜底 `fallback` + 防自食与回声抑制 + 语义召回（嵌入余弦 top-k，provider-agnostic，默认关、端点由配置注入）+ 注入面/召回面观测 | 已发布 |
| **v0.3.1** | 索引与注入的正确性/预算修复：全局索引保最新且五类都在、`injectMaxChars` 为含召回块的总预算、召回整体时间预算 `recallTotalBudgetMs`、召回块全块去重、嵌入「测试连接」不再转发已存密钥、索引文件名与磁盘逐字节一致、非法文件名显式拒绝、格式标记损坏先备份、`null` 请求体返回 400 | 已发布 |
| **v0.3.0** | 面向分发与升级：声明 DSH peer 兼容范围（宿主安装/启动做版本检查）+ GitHub tag tarball 分发渠道 + **存储格式版本闸**（`keepsake-format.json`：数据被更新版插件写入时本版本自动转只读，防降级误改；见 [FORMAT.md](FORMAT.md)）+ 只读态在门牌与「管道健康卡」显式可见 | 已发布 |

> 语义召回与消息通道注入均在 v0.2.0 内交付；后续版本按下面的方向推进，具体排期以仓库提交为准。

## 分发与升级

DSH 插件**不支持自动更新**——宿主插件管理器的官方口径是"升级 = 先卸载再装新版"。因此本插件的升级策略是"重跑一次安装命令 + 数据与代码分离"：

- **分发渠道**：GitHub 仓库 tag tarball（`.../archive/refs/tags/vX.Y.Z.tar.gz`，升级即换版本号）；本地 clone 仅作开发。**不发布 npm**（有意选择：零运行时依赖，tarball 直装即可，避免多一条供应链）。
- **数据在包外**：记忆/开关/人设/备份全部落 `~/.dsh/memory/`，与插件包目录分离——卸载重装天然不影响用户数据。
- **兼容声明**：`package.json` 的 `peerDependencies` 声明 DSH peer 范围，宿主在安装/启动时据此做版本检查（不匹配需用户显式 `allow-version` 豁免）。升级插件或升级宿主都会重新检查。
- **降级保护**：存储格式版本闸（见 [FORMAT.md](FORMAT.md)）——数据被更新版插件写入时，旧版本自动转只读并显式报警，杜绝按旧规则误改新数据。**v0.6.0 起 `FORMAT_VERSION=2`**：从 v0.6.0 降级到 v0.5.0 及更旧版本时该闸会触发（旧版读不懂 `pinned`，转只读后不会在覆写时把 pin 剥掉）；v0.4.0/v0.5.0 → v0.2.x 之间格式版本仍为 1，闸不触发，但降级会失去写入安全面（快照 / 回收站 / sha1 闸 / 写后校验），降级前建议先做一次全量备份。

## 未来方向（未承诺，按需推进）

- **检索增强**：召回块 supersede（避免旧召回块在长会话里累积，当前仅靠 compaction 收敛）。（写后读校验已在 **v0.4.0** 交付；注入 token 预算已在 **v0.5.0** 交付。）
- **格式与互操作**：跨 agent 记忆格式约定（见 [FORMAT.md](FORMAT.md)）；为将来 git 同步预留的可选墓碑删除字段（当前有意不实现）。
- **面板与诊断**：更细的管道/召回诊断面。

## 已知限制与有意不做的

- **脱敏是固定清单的正则尽力而为（有意不做自定义）**：内置 7 类模式覆盖常见密钥形态，非标准形态会漏检；正则替换也可能误伤正文语义（典型：内网 IPv4 一律替换，讨论网络排障的正文会被换占位符）。模式清单固定、**不支持用户自定义正则**（防正则回溯拖垮宿主进程）——这是防 ReDoS 的取舍，不是能力缺口。
- **自动补提只补 failed、abandoned 不自动重试（有意收口）**：已显式放弃的区间代表"重试不可能自愈"的结构性病因，自动重试会让"放弃"名存实亡；这类区间只经面板手动按钮重跑（人工判断后仍有出路）。
- **注入 token 预算是 CJK 感知估算（非精确分词）**：码点级近似（CJK 字 ≈1.5、其余 ≈0.25 token/字），不同模型分词器有偏差；定位是防挤爆上下文的护栏，不是精确计费。召回块自身不做裁剪、整块发出只压主块（与字符口径既有语义一致）。
- **人设/称呼无逐次编辑历史（有意不修）**：面板手动保存**人设 / 称呼**仍是直接替换，粘贴错即丢旧文（仅已损坏的档在覆盖前会备份 `*.corrupt-<ts>`）。**注意区分**：面板手动保存**全局条目**覆盖前会先把旧文留档到快照（**v0.4.1 起**，成功响应带 `preSaveSnapshotId`，「快照」页可按单文件找回），**删除条目**会移入回收站（**v0.4.1 起**，默认保留 30 天可找回）；自动提取对全局条目的覆写有批前快照、删除进回收站（**v0.4.0 起**）；批量破坏路径另有自动全量备份。
- **注入/召回块在会话内可能累积**：主注入块自 v0.4.2 起有块首取代声明（模型只认最新一块）与变更节流，历史块仍占上下文；召回块仅靠 compaction 收敛。`/state.injection` `/state.recall` 可观测累积速度。
- **防自食判据故意从窄**：提取侧排除任意插件的注入（`plugin:*`）与已知系统性消息（inject / instruction / summary / tool 等）；其余来源（含来源缺失、`plugin`、`steer` / `followup`）仍按普通用户内容对待（假阴性最多多跑一轮提取，假阳性会丢记忆，故取窄）。
- **不引入 JSON 真源**：markdown 即真源，保证用户可直接打开编辑。
- **不接云后端 / 不做 provider 化**：保住零依赖与本地优先。

## 兼容性

- 适配宿主：**DSH 0.2.0-rc.2**（web / headless / desktop 三个 profile）。
- 运行环境：**Node ≥ 18**。
- 存储格式在 v0.x 内保持稳定；如有破坏性变更会 **`FORMAT_VERSION` +1**、在迁移位登记，并同步本文件与 [FORMAT.md](FORMAT.md)。当前格式版本为 **2**（v0.6.0 起；v1→v2 为可选字段增量、无数据迁移）。

## 参与

- 安装与配置见 [README.md](README.md)；记忆文件格式约定见 [FORMAT.md](FORMAT.md)。
- 测试：`npm test`（零依赖，无需 install）。
