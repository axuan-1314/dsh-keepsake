# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，变更记录格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 新增

- **项目知识页（手动生成，默认不自动跑）**：每个项目可把现有记忆合成 5 页稳定视图（组件地图 / 核心概念 / 约定与模式 / 关键决策 / 进行中事项），参照 hindsight knowledge-page taxonomy，保持本地 markdown、零依赖、单次 LLM 调用。产物落 `<storageRoot>/pages/<projectId>/`（5 个 `*.md` + `manifest.json`），是**派生视图**，真源仍是条目；删掉可重建。面板「项目记忆」页新增「知识页」入口（查看 / 生成 / 重新生成，busy 单飞）；注入侧只带「标题 + 一行摘要 + 页面路径」并排在项目索引之前，记忆变化后标 `[stale]`；生成失败保留上一版 manifest。API：`GET /api/pages/read?projectId=…`、`POST /api/pages/generate`、`/state.pages`。生成走当前/最近会话路由（无会话时用 last-known），不自动触发、不增加每轮成本。
- **空闲整理（idle review，默认关）**：提取写入新条目后，延迟 60s 让模型做一次合并/更新/清理审查（最多 3 个 project-scope op，不碰全局）；每会话最小间隔 10 分钟、最多 5 次、全局单飞；模型只提案，落盘仍走批锁/快照/sha1/写后校验，delete 进回收站。失败只记 `/state.idleReview` 与日志，不中断提取。开关 `idleReviewEnabled` 在面板「设置」页，缺省 false。测试：`test/idle-review.test.mjs`（提示词契约 / global 过滤 / 最多 3 op / 落盘前脱敏 / 三类失败 + 记账）。
- **纠错闭环（correction loop）**：给「这条记忆记错了」一条正式通道——此前提取与整理只会 write/delete，错误事实只能靠下一轮提取碰巧覆盖，实际常留下两条互相矛盾的记忆。给定一条被判有误的条目，一次 LLM 调用产出**最小修正**（提示词明令禁止顺手整理无关条目；邻域只给同 scope 索引，不给别的正文）。三种结局如实回报：`applied`（附改写/删除条数）、`needs-input`（诉求不够具体 → 模型明确拒绝改动，记忆一字未变；**不是失败**，命令侧仍报 success）、`nothing`（无需改动）。落盘复用 `applyScopedOps`（批锁 / 手术式快照 / sha1 覆盖闸 / 写后校验），`delete` 进回收站；ops 全被闸拦下时判失败且**不写记录**——不谎报 applied。记录 `<storageRoot>/correction-ledger.jsonl`（1000 行轮转留尾 500、原子写、坏行跳过、写失败只 warn）。入口两处：对话 `/memory fix`，面板「最近活动」页检索结果「纠正这条」。API：`POST /api/corrections/correct`（参数不全 400 / 开关关或并发 409 / 无路由或无项目 503 / 闸全拦 422 / 其余 502）、`GET /api/corrections/recent`、`/state.corrections`。测试：`test/corrections.test.mjs`（14 条，含「不谎报 applied」「needs-input 不动盘不留记录」「空诉求不白烧调用」三条硬口径）+ `test/p1-wiring.test.mjs`（真实落盘后读回新正文）。
- **记忆检索（`/memory` 命令 + 面板搜索）**：关键词 AND 检索，打分口径 名字完全相等 100 > 名字包含 60 > 标题 45 > 摘要 30 > 正文 15；多关键词要求全部命中。索引文件（`MEMORY.md`）与派生/留档目录（pages / runtime / backups / trash / snapshots / surgical）不参与检索——索引混进来会让每次查询都命中它。命令经 `ctx.inject(["commands"])` 挂载（**不进 inject 硬声明**：宿主没有 commands 服务时记忆功能照常，只是没这条命令，且留一条 warn 不静默跳过）；`recordInput: false`（命令输入可能含个人事实，不进会话日志）。子命令：`/memory`（列最近）/ `<关键词>` / `why <关键词>`（附命中位置与相关度）/ `fix <关键词> | <诉求>` / `forget <关键词>`。API：`GET /api/search?q=`（q 空 400，不退化成"返回全部"）、`GET /api/search/list`。测试：`test/search.test.mjs` + `test/memory-command.test.mjs`（17 条）。
- **轮次活动条（turn bar）**：把提取 / 注入 / 空闲整理 / 纠错四面观测按**时间窗**归并成一条时间线，面板新增「最近活动」页。归并口径如实：提取事件自带会话号按会话精确匹配，注入/整理/纠错是进程级或显式动作只按窗口落流，**刻意不编造因果**。窗口默认 30 分钟、可切 10 分钟~1 天，请求超一周钳到一周并如实回报实际窗口；空态区分「宿主未提供数据」（旧版/未接线）与「这段时间没有活动」；失败事件带标记不与成功混同。纯派生计算，**零新增落盘**。API：`GET /api/turn-activity`（`window` 字段只在 provider 真被调用时出现——它是「接线活着」的判据）。测试：`test/turn-activity.test.mjs`（10 条）。
- **批量纠错**：面板检索结果可勾多条一次提交（`POST /api/corrections/correct-batch`，单批上限 10 条、body 上限 256KB）。每条独立一次 LLM 调用、独立成败——**不做成一次大调用**：合成一次会让一条的诉求污染另一条的判断，且任一条失败会拖垮整批。结局三档如实回报：`applied`（全成）/ `partial`（部分成，逐条在 `results[]` 里列明）/ `error`（全败）。超上限显式 400 `E_TOO_MANY` 且**一次调用都不发**（不静默截前 N 条——批量要烧 N 次调用，悄悄只做一部分等于骗人）；单条缺 target/reason 只废该条、其余照跑。UI 侧留空诉求的条目直接跳过（不扣调用），逐条结局逐条展示，不把 partial 说成整批成功或整批失败。
- **纠错历史按条目回看**：新增 `groupCorrectionsByTarget` 与 `GET /api/corrections/by-target?target=&scope=&maxGroups=`。面板纠错记录卡改双视图：「按时间」答「最近改了什么」（原视图），「按条目」答「这条被改过几次、每次改了什么」（点「看历史」展开明细）。归组**只算真正改了盘的**（`applied`）——`needs-input` / `nothing` / `failed` 没有盘上后果，混进来会让次数虚高；同名文件在 `project` 与 `global:<分类>` 是两个文件，按 `scope + target` 区分。顺带修掉一个真 bug：`appendLedger` 落的行原先没有 `outcome` 字段（只在 applied 路径调用，靠调用点位置隐含），按 outcome 归组的读侧因此永远筛不出东西——现在 `outcome` 显式落盘。

### 修复

- **注入预算紧凑索引兜底**：索引段（`globalIndex` / `projectIndex`）整段放不下时，先降级为紧凑索引（分类计数 + 最新 N 行 + 完整索引路径），仍装不下才整段丢弃；不再出现「runtime 开着时全局索引与项目索引同时被挤掉、模型看不到记忆目录」的情况。实现：`buildMemoryContext` 新增惰性 `fallbacks`（可丢段专用，锁定段永不替换；fallback 生成失败按无兜底处理），`/state.injection` 新增 `compactedSegments`（紧凑降级累计，区别于 `droppedSegments`），面板健康卡摘要同步显示「紧凑降级 N」。测试：`inject-channel` 6 条 fallback 单测 + 接线级项目索引 compact 测试（40 条索引超预算 → 注入 `40 entries; showing latest 8` 并记账 `compactedSegments=1`，`droppedSegments=0`）。无新增配置键、无数据迁移。

## [0.7.1] - 2026-10-25

**全面检查后的修复批：2 条 P0 + 4 条 P1 + 8 条 P2/P3 + 一项测试债务。** 对 0.7.0 之后四个提交（组织层三件套 / 纠错闭环与检索命令 / 纠错增强 / 面板枚举翻译）做了四路独立审查，每条发现都用隔离探针复现过；随后又做了两轮独立对抗式审查，抓出的问题（片段定位线性漂移、422 丢掉原因、两阶段落盘的备份空窗与静默回滚失败、安全闸被放宽、两处假绿测试）已在本批内修完。无新增开关、无配置键变更、无数据迁移；测试 1253 → 1286（+33）。

### 修复

- **批量纠错的「逐条失败隔离」原来不成立（P0）**：`applyCorrections` 的循环体没有兜住逐条定位（`resolveBody` / `resolveNeighbors` 会抛 `E_INVALID_SCOPE` / `E_INVALID_PROJECT` / `E_NO_PROJECT`），异常直接冲出整批 → API 报 400 且**响应里没有 `results[]`**。此时前面已成功的条目**已经改了盘、已经花掉 LLM 调用**，用户看到的是「整批没执行」，重试还会让成功的那条再跑一次。现在只把定位层包进 try/catch（`applyCorrection` 内部对 LLM/解析/落盘的失败另有判 error 语义，外层不接管它的返回值），任一条定位失败只废该条并如实进 `results[]`。
- **纠错读取能读到记忆目录之外的文件（P0）**：`resolveCorrectionBody` 的 project 分支用 `join(memoryDir, target).startsWith(memoryDir)` 判包含性，而这是**字符串前缀**比对——`../memory-extra/secret.md` 规范化后是 `<memDir>-extra/secret.md`，天然以 `memDir` 开头，于是兄弟目录的文件被原样读出、当成 `currentBody` 塞进提示词发给模型（已实测复现）。改为与落盘侧完全同一把尺子 `resolveSafeMemoryTarget`（sanitize + 绝对路径包含性双闸）。
- **轮次活动条遇越界时间戳整页 500（P1）**：`msOf` 对数字型时间戳无条件放行，`8.64e15+1` / `1e17` 这类值一路走到 `new Date().toISOString()` 才抛 `RangeError`，被 API 接成 500 `E_TURN_ACTIVITY`，把提取/注入/整理/纠错四面本来可看的数据一起打掉。现在 `msOf` 做 Date 可表示范围夹取，越界值返 `null`（各调用点已正确处理 = 跳过该事件，不编造归属时间）。顺带修掉 `since > until` 时回报**负宽度窗口**（面板会算成「最近 0 分钟」，看起来像刚看过、没事发生）——非法窗口钳到 `until`。
- **全批 `needs-input` / `nothing` 被报成失败（P1）**：批量 `outcome` 原先只看 `applied` 数量，`applied === 0` 一律判 `error`，于是两条都返回「说明不够具体」时面板显示「全部失败（0 条失败）」，同屏逐条却写着「未改动」——三处信息互相矛盾，且 `onDone()` 不触发、列表不刷新。单条路径一直把 `needs-input` 当非失败（命令侧仍报 success），批量现在对齐：新增 `no-change` 档（一条都没成但也没有失败），`error` 只留给「全败」。面板 head 与 toast 同步。
- **按条目看历史会「改过却说没有」（P1）**：`groupCorrectionsByTarget` 读取窗口被 `maxGroups*4` 卡死（默认 200 行），超过窗口的历史记录查出来是「0 组」——用户据此判断要不要再纠一次。改为扫全量（文件本身有 1000 行轮转上限，全量读有界）。
- **`/memory` 列表给的不是「最近」（P1）**：`listMemoryEntries` 在每个分类目录内先到先得地灌满 `cap`，而 `CATEGORY_IDS` 顺序固定，于是 `work-profile` 满 10 条后，用户在 `user-profile` 刚写入的条目**永远不出现在列表**里。改为全量收集后按 mtime 排序再截断（总量上界仍由 `SEARCH_SCAN_MAX_FILES` 保证）。

### 修复（P2/P3 收尾，同一次检查的剩余项）

- **检索不认全角与 NFC/NFD 变体（P2）**：正文写 `ＰＮＰＭ`、用户查 `pnpm` 命中 0 条；`café` 的两种 Unicode 规范化形态互查也是 0 条。字面检索的承诺就是「打出来就找得到」，现在正文与查询两侧统一做 NFKC + 小写折叠。片段仍从**原文**切（折叠会把全角标点也改写，直接显示折叠串等于替用户改正文），用「组合簇 → 原文下标」映射换回位置。
- **写后校验回滚的改动在界面上不存在（P2）**：`verifyFailed` 埋在 `applyResult` 里，命令只说「已纠正 X：1 处改写」、面板只说「已纠正 N 次（改写 X）」。一处改动被打回、另一处落成时，用户会以为全改成了。现在回报、ledger 行、进程计数、命令文案、面板健康卡五处都带着它。
- **知识页 stale 判定漏标（P2）**：指纹是 `mtimeMs:size`，同长度改写 + mtime 复原（备份还原、跨设备复制、编辑器保留时间戳）时完全不变，`[stale]` 永远不出现。改为索引文件内容哈希（只读单个文件，有界）。
- **知识页落盘会留半新半旧（P2）**：原先逐页 `atomicWrite` + 最后写 manifest，末页失败就留下「4 张新页 + 旧 manifest」——manifest 的承诺字面成立，但用户读到的页和注入摘要里的标题/摘要对不上。改为两阶段：先全部写 `.tmp-new`（失败只清临时文件、现场零改动），再统一换入；换入阶段失败按 `.tmp-old` 备份整体回滚到旧版。顺带补一个真实隐患：目标路径被目录占用时显式报错（Windows 上 `rename` 对「目录 → 文件路径」是允许的，会把用户目录静默挪走再删掉）。
- **空闲整理被单飞挡回时完全静默（P2）**：另一个会话的整理在跑时直接 `return`，`count`/`lastAt` 都不动，形成「每次提取都白等 60s、次次被挡」的循环，面板上没有任何解释。现在单独计数 `rejected` + 记最近原因，并把 `lastAt` 推后让 min-interval 闸接管；面板健康卡新增「整理」一行。
- **知识页生成失败在用户面不可见（P2）**：`/state.pages` 一直在记账（generations / errors / lastError），面板零消费——注释还自称「面板通过 /state.pages 消费」。现在健康卡新增「知识页」一行，生成次数与失败次数（附最近错误）都露出来。
- **符号链接目录会被检索跟随（P2，跨平台潜在越界读）**：`walkMarkdown` 用 `entry.isDirectory()` 判断递归，而 Linux/macOS 上 symlink 目录该值为 true，会递归到 `storageRoot` 之外并把外部文件读进检索结果。改为符号链接一律不跟随。
- **删掉两个死导出（P2）**：`turnEventLine` / `turnWindowText` 全仓仅测试引用，与 `panel-logic.js` 的 `turnActivityRows` / `turnActivityNote` 口径已漂移（47 小时 vs 2 天的边界不同）。按「删除优于兼容」删掉，测试同步移除。
- **P3 文档漂移**：`corrections.js` 头部字段注释写的是 `action` / `reason`，实际落盘是 `outcome` / `scope`；README / README.en 的窗口档位漏列默认的 30 分钟。

### 修复（对抗式审查发现，同批收口）

- **片段定位会线性漂移（P1）**：检索折叠用整串 NFKC（会把相邻字素**合并**：韩文兼容字母 `ㄱ`+`ㅏ`→`가`），而位置映射按字素铺开——每次合并偏差累加一格。段内 2000 次重复后命中，片段窗口落在正文第 1 个字符处，命中词根本不在片段里（等于没定位）。改为在前缀折叠长度上**二分**回推原串下标（前缀折叠长度对字素边界单调）；快路径（直查映射命中）保持零额外开销。
- **单条纠错的 422 丢掉真正原因（P1）**：写后校验把唯一改动打回时，`/api/corrections/correct` 只回 `{error, code:"no-op-applied"}`，`verifyFailed` 被丢在服务端——面板单条路径因此只能说「纠错未生效」。现在 422 响应带上 `verifyFailed`，面板据此说清「N 处写后校验没通过、已回滚」；`no-op-applied` 路径也进累计计数（原先只有 applied 计）。
- **两阶段落盘的两个新问题（P1/P2）**：① 备份原用 `rename` 挪走目标文件，在「挪走→换入」之间目标**短暂不存在**，此刻崩溃即永久丢页（比原混合态更糟）；改为 `copyFileSync` 备份 + 原子 `rename` 覆盖（已用崩溃打点验证任何时刻 `missing=0`）。② 回滚失败被 `catch {}` 静默吞掉，盘上可能停在混合态而调用方毫不知情；现在收集失败项并挂到抛出的 error 上（`error.rollbackFailures` + 日志）。
- **安全闸被放宽（P2）**：为读回「名字不经 sanitize 的真实条目」，精确匹配分支一度只看词法包含性，于是 `.git/config`、`node_modules/**`、索引 `MEMORY.md`、`.env`（含明文密码/密钥）都能被当记忆正文喂进提示词。现在该分支复刻落盘侧的段级闸（只收 `.md`、拒索引名、拒黑名单段、拒 Windows 设备名），并用 `realpath` 再判一次根内（挡 symlink/junction 指向外部）。
- **闲置整理的原因语义（P2）**：先前在「跑成功」时清空 `lastRejectReason`，面板会落到兜底文案「上一轮未结束」——那是编出来的原因（`aborted` = 插件在卸载也会被这么说）。现在原因作为历史事实保留，另记 `lastRejectAt`，渲染层按时间戳区分「现在仍被挡」与「曾挡回」；未知原因如实显示，不编。
- **批量 verifyFailed 无汇总（P2）**：逐条 `results[].verifyFailed` 有值但顶部不汇总，面板结果头与 toast 都消费 `out.verifyFailed`——汇总一漏，批量视图上「某条里有一处被打回」完全不可见。现在顶部汇总逐条之和，面板逐条行与标题都显示。
- **`listMemoryEntries` 性能与上限口径（P2）**：改为「先 stat 排序、只读入选的 top-N 正文」（原先全量读正文，7500 条约 5 秒）；同时把「每目录扫描上限」与「因 limit 截断」分开，新增 `scanTruncated` 如实回报（原注释声称总量上界是全局的，实际是每目录）。
- **两处假绿测试（P2）**：①「阶段一失败零残留」实际只跑了重复 id 预检，从未触发阶段一失败——删掉清理循环全仓仍全绿；改为钉住 `Date.now` 精确占住临时文件路径，真正触发 `EISDIR`。②「同长度改写 + mtime 复原」的 size 前提断言拿同一个字符串比字节数，是恒真式（换成等字符数但不等字节的中文就退化成假绿）；改为与**生成时记下的真实 size** 比。

### 测试（1253 → 1286，+33）

- **新增 `test/corrections-wiring.test.mjs`（11 条，全走真实 `apply()`）**：补的正是「文档承诺了、实现是对的、但没有任何回归保护」的四项——并发第二次纠错 409 `E_BUSY`（单条 + 批量互斥各一条）、开关关 409 `E_DISABLED` 且零 LLM 调用、ops 全被闸拦下 422 `no-op-applied`、`recent` 与盘上 ledger 行数对账；外加两条 P0 回归（批量定位失败时的逐条隔离与「已落盘条目必须留在 results 里」、越界读取不得把目录外内容喂进提示词）、一条 `no-change` 口径，以及安全闸的两个反向约束（目录内非规范化真实文件名**必须**能读到 / 目录内的索引、黑名单段、非 `.md` 文件**不得**读到）。
- **`test/turn-activity.test.mjs` +4**：越界数字时间戳不炸、合法但久远的时间戳仍保留（防夹取写成一律丢弃）、`since > until` 不产生负宽度、`since=1e308` 同样钳住。
- **`test/search.test.mjs` +8**：跨分类按 mtime 取最近、符号链接目录不跟随（Windows 建不了 symlink 时自动 skip）、全角正文与半角查询互通且片段保留原文、NFD 正文与 NFC 查询互通、相邻字素被 NFKC 合并时片段仍能定位（韩文兼容字母 2000 次重复的线性漂移回归）、任意 max（含负数）不产生孤立代理、只读 top-N 的性能校验、扫描上限 `scanTruncated` 如实回报。
- **`test/pages.test.mjs` +5**：同长度改写 + mtime 精确复原后仍标 stale（含「mtime 与 size 必须真的一模一样」三条前提断言）、旧格式 `mtimeMs:size` 的 indexStamp 不产生升级假 stale、单页落盘失败时不留下半新半旧、阶段一失败零残留（钉住时钟真正触发 `EISDIR`）、重复 id 显式拒绝。
- **`test/panel-logic.test.mjs` +4**：`verifyFailed` 必须单独露面、`idleReviewSummary` 的挡回带原因（且区分「仍被挡」与「曾挡回」、未知原因不编）、`pagesGenerationSummary` 的成功与失败各自可见、**结构校验**「`CORRECTION_KIND_TEXT` 键集 ⊇ `CORRECTION_KINDS`」（原先只有硬编码的"五值都在"测试，加第六种类型时面板不会红）。
- **`test/corrections.test.mjs` +3**：verifyFailed 三处链路（回报/ledger/累计计数）、`no-op-applied` 路径也要带并累计 verifyFailed、批量顶部汇总等于逐条之和。
- **`test/memory-command.test.mjs` +1 / `test/idle-review.test.mjs` +2**：命令文案里被打回的改动必须明说（含 default 分支的校验回滚文案）；挡回单独计数且不污染 `runs`、挡回原因作为历史事实保留而「仍被挡」由时间戳判定。
- **变异验证（12 处）**：折叠退回纯小写、指纹退回 `mtimeMs:size`、移除回滚循环、删掉阶段一清理、`verifyFailed` 恒 0、命令文案恒空、`recordIdleReviewRejected` 空实现、`pagesGenerationSummary` 恒 null、往 `CORRECTION_KINDS` 塞没中文的类型、`listMemoryEntries` 退化成全量读正文、删掉精确匹配分支、`isInsideRoot` 换成 `startsWith`——每处都让对应测试变红，恢复后转绿。**其中两个测试第一版是假绿，都已修**：① Windows/NTFS 时间戳精度 100ns 而 Node 的 Date 只有 ms，直接写回原 `mtime` 会差出亚毫秒，指纹「其实变了」所以照样标 stale（改为钉整秒 + 三条前提断言）；②「阶段一失败零残留」从未真正触发阶段一失败（改为钉住 `Date.now` 用目录占住临时路径，触发 `EISDIR`）。


## [0.7.0] - 2026-10-24

**召回端点故障可见化 + 硬事实守护指路 + 在途中止分类 + 零正文失败路径。** 本批由三个模块并行开发、随后经三路独立检查（测试有效性 / 自伤路径 / 终端用户视角）发现 2 条实现 P0、2 条检查 P0 与若干 P1，逐条修复后收口。先交代三件对账事实，防止后续翻案：
- **方案 v2 §4.1（放弃闸重设计）的前提不成立，本批不动放弃闸。** 重启后 journal 里 0 条 `no-route`（级联已断），唯一残留失败族是 `ABORTED`（见修复③）。
- **「max-tokens 复发」被证伪。** 此前把重启后一条 `llm-error` 误读成 `kind=max-tokens`——逐字节核验原文是 `ABORTED`；最后一条真正的 max-tokens（`11:22:48Z`）早于插件重启（`13:32:50Z`）。注意插件经 npm link 开发安装、直连本仓工作树，**代码生效看重启时刻，不看提交时刻**。
- **但「零正文 max-tokens」这个失败模式本身是真的**（上一批之前 81/88 条 llm-error 都是它），且机制已在本机网关实测坐实：思考 token 与正文**共享同一个 `maxTokens` 预算、思考链先跑**（`max_tokens=64` → reasoning 258 字符 / content 0 字符），丢 `reasoningEffort` 救不了（不传档位模型照样思考）。本批修的是它的失败路径——有界、不重演上一批。

### 修复

- **在途中止按「执行结果」分类（本机真实故障，本批含金量最高的一件）**。本机 `extraction-errors.log` 13:28/13:37 两条 `llm-error … ABORTED`：插件 `callLlmText` 的单次超时计时器（默认 120s）`controller.abort()` 后，宿主把它映射成 `code=ABORTED`——**不在可重试族** → 一次判死；1291-seq 的大区间（越长越有价值）最容易被它吃掉。修法两条，判据全是执行结果、不猜错误形状：① 计时器超时 → 按 `controller.signal.reason === timeoutError` 补挂宿主同形 `code=TIMEOUT`（既有可重试族）→ 链上退避重采样；② dispose 在途（卸载打断在途 attempt）→ `runAttemptChain` 捕获处先查 `lifetime.signal` 本尊 → 按 `aborted` 收场，不进 `llm-error` 桶、不推失败连击（是我们在卸载，不是模型失败）。
- **零正文 `max-tokens`：显式配小上限的用户有界逃逸；跟随模型不进重试链（成本纪律）**。显式配了 `maxOutputTokens > 0` 时零正文 → **丢掉该上限、改跟随模型重发一次**（唯一真正改变预算的手段，实测同一 prompt 不下发上限时正文正常产出），只逃逸一次，且**重发拿到正文才计数**（`escapeRetried` 在成功返回点记，发起不计——此前检查抓过"逃逸失败时健康卡同时显示『提取失败』与『重发成功』"的意图当结果）。**刻意不给它开链级重采样**：实现版曾自造 `code=OUTPUT_BUDGET_EXHAUSTED` 进 `RETRYABLE_FAILURE_CODES`，权衡后移除——跟随模型（本机 25 万 token 预算）仍零正文在实践中不可达，为它重采样最坏是 `retryAttempts × fallback 条数` 次满预算调用（实测 `retryAttempts=10` + 3 条 fallback = **84 次**），拿真金白银换一个几乎不存在的场景。`RETRYABLE_FAILURE_CODES` 保持宿主 `DEFAULT_RETRYABLE_CODES` 五项镜像（有测试钉住集合本体）。
- **召回端点配错：从「启动即抛、整个插件起不来」改为「插件照常加载 + 面板/门牌红条指路」**（方案 v2 §4.2 降级落地，不加开关）。原实现：`resolveConfig` 对「`recallEnabled: true` 但缺 `embeddingBaseUrl`/`embeddingModel`、或 `injectChannel` 不是 `message`」直接 `throw`，而 `apply()` 第一行就调它——用户没填一个**可选功能**的端点，代价是连核心的对话记忆提取与注入一起起不来。现在拆成两类：
  - **静态配置类**：不再抛错。`recallEnabled` 被**显式置 false**（运行时零嵌入调用，不是"开着但每轮白撞"的 fail-open），诊断经 `/state.recallDiagnostics` 透出，红条文案（`L.recallDisabledNoticeText`，面板/门牌/启动日志同一出处）**三岔口径、全部按当前生效配置每轮现算**：①缺端点/模型 → 点名键名 + 面板「嵌入服务」卡 + **必须同时打开「开启语义召回」开关**（检查 P0：开关预填 false，用户照旧文案填完端点后红条让位、召回静默不工作）；②`injectChannel` 不是 message → 只能改 `cordis.patch.yml`（明说面板改不了；用户补齐端点后红条改为只报通道问题，不再谎报缺键——检查 P0）；③配置齐了但开关没开 → 显式 `switchOff` 红条（两路检查各自独立抓到的 fail-open：旧 `rescuedBySettings` 只看端点/模型不看开关）。诊断每轮现算的副产品：**热恢复**——用户补齐配置后不重启即恢复（有测试）。仍然启动即抛的只有"配错"（URL 非 http(s)、键类型非法），与其它配置键 fail-loud 同口径。
  - **运行时故障类（端点连不上/超时/HTTP 错）**：熔断语义一字未改（3 次 → 冷却 60s），只补可见性——`/state.recall.errors` 非零时面板与门牌出红条（与静态类互斥显示），文案注明「只影响语义召回，其它功能不受影响」。
- **硬事实守护策略（`hardfactPolicy`）面板指路**（方案 v2 §4.3，按既定设计只加文案不加控件）：设置页「保留策略」卡一段说明——守护什么（正文里的数字、版本号、十六进制标识、字节尺寸这类写错一个字符就可能跑不通的内容）、当前值（warn/block 各自意味着什么；脏值如实标「不认识（按 warn 生效）」，不冒充现值）、去哪改（settings.json 的 `hardfactPolicy` 键，下一轮生效），并如实说明为什么不给控件（拨到 block 会把合法更新一起回滚，用户看到「我改的记忆自己变回去了」）。检查后修正两处：**路径不再写死 `~/.dsh`**（`storageRoot` 可配，改由 `/state.storageRoot` 现算，自定义路径的用户不再被指错路）；删掉「当前值 warn——warn：」的自我复述。
- **红条指路路径动态化（同上口径）**：召回红条里的 settings.json 路径同样由 `/state.storageRoot` 现算，缺省才回落 `~/.dsh/memory/settings.json`；`/state.recallDiagnostics` 增 `requested` 字段（entry 是否请求过召回），单独透传的 `recallRequested` 死字段移除。

### 测试（1126 → 1152，+26）

- **零正文逃逸（3 条 + 集合钉 1 条）**：显式上限 + 两趟零正文 → 逃逸重发成功落盘且 `escapeRetried=1`；跟随模型 + 零正文 → **恰好 1 次调用**（不逃逸、不进重试链——变异：把自造 code 同时加回集合与补挂 → 必红）；逃逸那趟仍零正文 → 恰好两趟后 llm-error 且 `escapeRetried=0`（结果口径）；`RETRYABLE_FAILURE_CODES` 集合本体 deepEqual 宿主五项（防将来混入自造 code）。
- **在途中止分类（2 条，全走真 `apply()` / 真 REST 面）**：①在途超时 → `retried≥1`（真实重采样）、失败摘要带 TIMEOUT（变异：摘掉 TIMEOUT 补挂 → 必红）；②dispose 在途（**走补提路径触发**——scheduler.dispose 会先有界 drain 在线提取，在线路径的 abort 永远落在两次 attempt 之间，只有补提不经 scheduler 才能确定命中"attempt 中途被打断"）→ `llm-error` 桶不增、journal 不记 llm-error（变异：摘掉 dispose 检查 → 必红）。**变异期间抓掉两个假测试**：假流"永不 yield 的死流"对 abort 信号无动于衷、extractSession 永远挂在 for-await 上，dispose 路径根本没走到——改为挂起至 signal abort 后抛宿主形状 ABORTED。
- **召回降级（`test/recall-degrade.test.mjs`，14 条；全走真入口）**：缺键不抛 + 插件照常加载 + `/state` 诊断形状；只缺 model / 通道 section 各自精确；**有候选前提下**零嵌入调用（检查 P1：无条目时 fail-open 也不会发请求，断言无区分力——现在先 `createEntry` 再断言 0）；面板红条渲染级（含自定义 storageRoot 路径 + switchOff 岔 + 不得谎报缺键）；门牌兜底表驱动逐字一致（含 switchOff）；运行时故障端到端 + 推行锚；熔断常量 3 次/60s 未动；边界（配错仍抛 / 没请求过不出红条 / 配齐无诊断）；**switchOff 显式红条**（变异：摘掉 switchOff 岔 → 2 条红）；**热恢复**（补开开关不重启即恢复）。
- **hardfact 指路（2 条渲染级）**：真实行模板求值（warn/block/缺失/脏值 + 自定义 storageRoot 路径 + 路径参数兜底）；无控件判据升级为「卡内白名单外一律违规」（检查 P1：旧判据只认带 `keepHardfact` 的标签，radio/checkbox 可绕过）。
- **推行锚补强（检查 P1：只锁 const 行锁不住"算了但没 push"）**：`escapeLine` 与 `recallFailureLine` 的 push 行各有测试。

## [0.6.5] - 2026-10-23

**提取韧性三修：输出预算跟随模型 + 显式降思考档 + 失败不再自删路由 + 补提路径复原路由；外加「证明修复真的生效」的三项观测能力。** 本机 `extraction-errors.log` 309 行里 `llm-error` 88 条，其中 **81 条是 `kind=max-tokens`**；且 `llm-error → no-route` 转移 75/88——一次模型侧抖动被两条缺陷接力放大成结构性失败链。修完四件止血后有**三个观测缺口**导致无法验证修复是否真生效，本批补齐。无新增依赖，`FORMAT_VERSION` 仍为 2。

### 修复

- **输出预算固定 4096 吃光带思考模型的输出**：`maxOutputTokens` 语义改为 **0 = 跟随模型**（新默认），且为 0 时**不下发 `maxTokens` 键**（宿主 `resolveCallFor` 只在 `maxTokens === undefined` 时材料化模型默认值，传 0 会被当成 0 预算）。`cordis.patch.yml` 同步改为 0。
- **从不显式降思考档**：新增 config `extractReasoningEffort`（`minimal|low|medium|high`，默认 `low`，非法值启动即抛且提示允许值）。此前提取调用只传 `maxTokens`、从不传 `reasoningEffort`，宿主因此套用模型默认最高档，单次思考就把预算吃满、正文零输出。
- **`kind=max-tokens` 一次判死**：`callLlmText` 改为 `{ text, truncated }` 返回形状；`max-tokens` 且已累积正文时不再直接抛错，而是带 `truncated` 标记交回调用方**先尝试解析**——解析成功即照常落盘并记新观测键 `truncatedParse`（进 `journal.shapeRun` 白名单，跨重启可重放），解析失败才记 `parse-error`（并显式标注是否截断所致）。正文零输出仍判 `llm-error`。
- **失败自删路由 → 级联 no-route**：`llm-error` 后不再 `delete st.route`，保留 last-good 路由；「中途换模型可自愈」改由新增的 `routeStale` 标记承担——失败后到达的 `assistant/message.source` 允许覆盖旧路由（`request/header` 本就无条件覆盖）。
- **补提路径 100% no-route**：`createSessionAdapter` 现在扫描读回事件复原路由（`routeFromEvents`：`request/header` 优先、`assistant/message.source` 兜底、同一来源取最后一条），落在适配对象的新字段 `recoveredRoute` 上；`extractSession` 路由解析加入第三级 `session.recoveredRoute`。字段名刻意带 `recovered` 前缀，不与宿主 `Session` 的既有属性面冲突。
- **宿主能力校验的边界**：宿主对不支持的思考档会在 provider I/O 前以 `code=UNSUPPORTED_REASONING_EFFORT` 拒绝（非思考模型完全没有 reasoning 元数据）。`callLlmText` 命中该 code 时打一条 warn 并**不带档位重发一次**，同时把该路由记进进程内 `reasoningUnsupported` 表，后续同路由不再下发——降级可见、不静默、不无限重试。

### 观测能力（三项缺口：修完了却证明不了生效）

- **token / 成本观测（P0）**：`callLlmText` 此前只认 `text-delta` 与 `finish`，把宿主的 `{type:"usage", usage:{inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens?}}` chunk **直接丢弃**——于是 `maxOutputTokens` 从 4096 抬到模型默认（本机 250000，61 倍）之后，单次输出上限放大 61 倍、成本可能被带飞而完全看不见。现在每趟（含降档重发第二趟）收口时记账，新面 `/state.extractionFailures.extractionTokens` = `{ input, output, total, calls }`。口径：`calls` 记真实发起的调用次数（含降档重发那趟、含失败途），宿主没发 usage chunk（旧适配器）时 token 记 0 但 `calls` 仍计数——「调了几次」与「花了多少 token」分开报；`total` 取宿主 `totalTokens`（含 cache 读写，缺失才回落 `input + output`），不自己凑数。
- **`/state` 去重口径（P0）**：新增 `/state.extractionLog.coverage` = `{ distinctFailedRanges, distinctWrittenRanges, distinctAbandonedRanges, writtenRangeRate, writtenRangesTotal, failedRangesTotal, abandonedRangesTotal, scope: "range" }`。**这是验收的唯一判据**：修复生效后「不再反复白撞同一区间」会让 `failed` 计数下降，但那不等于记忆变多——只有 distinct `(sessionId, from, to)` 区间数说得清。口径如实标注为**区间口径不是轮次口径**：宿主不提供总轮次数，故 `writtenRangeRate` = `written / (written + failed + abandoned)`（区间级成功率），分母不含 skipped/zero-ops（无区间成败语义），也不编一个轮次数。`*RangesTotal` 是不去重行数，与 distinct 并排，`行数/distinct` 即「平均每区间结账几次」。journal 侧进程内累计 + 重放同源（`runs` ring 只有 30 条且会被轮转裁掉，从 ring 现算必少算）；`parseReplayLine`/`shapeRun` 白名单语义未动（不新增盘上字段，纯读侧统计）。
- **截断与降档上用户面（P1）**：`truncatedParse > 0` 的 `written` 行标签附「（输出被截断，可能少存）」（`extractionRunLabel`）；`reasoningDegraded > 0` 时健康卡与门牌各显示一行「思考档降级 N 次（该路由不支持所配档位…）」（新增纯函数 `reasoningDegradedText` + `EXTRACTION_BUCKET_KEYS` 增桶）；面板最近失败表的 reason 列改走 `L.reasonLabelOf(...)` 与测试中文化口径统一（检查点名的遗留：此前直接 `esc(r.reason)`，面板上会露 `no-route` / `llm-error` 这类英文枚举）。门牌侧同步内联兜底（`reasoningDegradedTextFallback`），双端逐字一致。

### 测试

- 新增 `test/extract-route-resilience.test.mjs`（12 条）：预算缺省 0 且 options 无 `maxTokens` 键、思考档缺省/显式/非法、`UNSUPPORTED_REASONING_EFFORT` 降级重发一次且同路由不再白撞、截断可解析即落盘 + `truncatedParse` 跨 journal 实例重放仍在、半截 JSON 走 `parse-error`、零输出仍判死、`llm-error` 后同会话下一轮不产生 `no-route`、失败后新 `source` 能顶替旧路由、`routeFromEvents` 优先级、补提经真 REST 面发起真调用且路由来自读回事件。全部走真 `apply()` 入口/真 REST 面，未复刻接线。逐条做过拆改验证（摘掉对应修复 → 必红）。
- 新增 token/成本面测试（6 条）：`test/observability.test.mjs` 3 条（累计/两次累加/cache 时 host total 优先、脏 usage 钳零 + 无 usage 只计 calls、快照拷贝不可变）+ `test/extract-route-resilience.test.mjs` 4 条端到端（假 llm 发 usage chunk → 真 REST `/state` 快照 `input=100/output=500/total=600/calls=1`；两次调用累加；降档重发第二趟也计；旧适配器无 usage chunk 不抛错且 `calls` 仍计 1）。
- 新增去重口径测试（5 条）：`test/journal.test.mjs` 3 条（3 条同区间重复失败 + 1 条不同区间 + 2 条成功 → `distinct=2` 而行数 4；跨重启重放不缩水 + 同区间再记 3 次 distinct 不动行数 +3；按会话分键 + 零结算 `rate=null` 不编数）+ `test/api.test.mjs` 2 条（同构造经真 REST `/state`；`ringMax=2` 下跨重启一致）。
- 新增用户面测试（6 条）：`test/panel-logic.test.mjs` 2 条（`truncatedParse` 截断标 + 与落盘失败并存不互顶、非 written 不带标；`reasoningDegradedText` 含「降级」且零值/旧宿主 null）+ `test/panel-drift.test.mjs` 3 条（**渲染级**：把面板真实行模板抠出来求值，reason 列不得命中 `/\b(no-route|llm-error|parse-error|io-error|no-cwd)\b/；降级摘要接线；截断标记随行标签出）+ `test/client-source.test.mjs` 1 条（`reasoningDegradedTextFallback` 表驱动与实现逐字一致 + 双端消费锚）。
- 拆改验证（逐条「摘修复 → 必红 → 还原 → 绿」）：删 `callLlmText` 的 usage 分支 → 4 条 usage 测试红；把 distinct 改成行数统计 → 4 条 coverage 测试红；删 `truncatedParse` 附标分支 → 2 条红；`EXTRACTION_BUCKET_KEYS` 去掉 `reasoningDegraded` → 1 条红；面板 reason 列回退 `esc(r.reason)` → 渲染级测试红；门牌降级文案与 panel-logic 漂移 → 防漂移测试红；面板降级摘要改接别的函数 → 2 条红。测试总数 1104 → 1123。

## [0.6.4] - 2026-10-22

**上两批修复自身引入的缺陷 + 五路检查 P2/P3 收尾。** v0.6.2/v0.6.3 修掉了真问题，但后续独立检查（含对「修复本身」的复查）发现其中两条修法各有反向副作用、另有若干遗留。本批把 2 个 P0 级回归、5 个 P2、5 个 P3 全部收口，并补上检查点名的最大测试空白（memo 链路端到端）。无新增开关、`FORMAT_VERSION` 仍为 2。

### 修复（P0：上批修复自身引入的回归）

- **脱敏后的 `name` 撞名 → 误删/合并无关记忆**：v0.6.3 把 `name` 加进脱敏列，但替换结果都是 `[redacted]`，经 `sanitizeMemoryName` 归一后同为 `redacted.md`。后果有两个：① 两条不同密钥名的条目合并成一条（后者被「并发建出」闸跳过，静默丢失）；② **`delete` 一条密钥名条目会命中盘上一条完全无关的 `redacted.md` 并把它移进回收站**。现在脱敏后的 name 追加「源名短指纹」（`[redacted]-<8位十六进制>`，sha256），保证不同原名映射到不同结果；无命中的普通文件名原样保留、不加后缀。
- **索引终态按「op 意图」而非「执行结果」判定 → 记忆对注入面静默消失**：v0.6.2 把终态改成「按 ops 数组里最后一次出现的 action」，但 op 只是意图——被闸拦下（锁被占 / 快照失败 / 回收站移入失败 / sha1 不符 / 写后校验失败）时事实未变。于是：① `delete` 被锁阻断、文件还在盘上，但索引行被删 → 该记忆此后每轮注入都看不见，面板却照旧列着它；② `delete` 成功 + 同批 `write` 被拒、文件已不存在，索引留悬挂行 → 模型被指去 Read 一个不存在的文件。**这恰好是本批声称要根治的那类缺陷，换了入口重现**。现在终态只看「真成功执行的那次动作」（`touched` / `deletedNames` 都是执行结果），并支持同名多条按执行先后取最终事实。

### 修复（P2）

- **非 pinnedOver 场景的淘汰提示行仍可被静默丢弃**：v0.6.3 只修了 pinnedOver 分支。当剩余空间落在 `[0, 短提示行字节)` 且 `includedRest` 为空时，提示行被清空，产物「有 N 条淘汰候选却一句不提」；更糟的是若此前已为腾空间退掉真条目，等于**代价付了、痕迹抹了**。现在只要发生过「为放提示行退条目」，提示行必须留（允许 `bytes > quota` + `status=overQuota`）——把代价与事实一起暴露。
- **`abandoned` 计数在主档被删后变幽灵值**：sidecar 记「被轮转裁掉多少条」，但主档按文档承诺可安全删除、sidecar 不会跟着删。之后重启会从 sidecar 回灌历史值，「已放弃 N 轮」虚高且跨重启不消失。现在主档不存在时 sidecar 视为过期：归零 + 清理 + 留痕。
- **`retired-*` 永久垃圾无回收路径**：失败路径保留退役副本是对的，但这些目录被清扫红线永久豁免，每失败一次就永留一份完整数据副本。现在恢复**全程成功**时顺手清理历史遗留的 `retired-*`（本次两份由成功路径各自处理）；仍然失败则一份不动。
- **全局同批同名重复写绕过整套硬事实判据**：硬事实比对拿的是「批前原文」，同批第二条 `write` 直通覆盖第一条的新值，`hardfactPolicy=block` 被最普通的「写两次」绕过、`hardfactDrops` 漏计。现在与 project 侧同口径：同批同名第二条 fail-closed 跳过（计入 `blockedDestructiveOps` 并 warn）。
- **`backups/` 下中断的原子写 tmp 永不清理**：`createBackup` 在备份目录内原子写 `backup-meta.json`，中途崩溃留下的 `*.tmp-<pid>-<ts>` 此前既不在扫描面（`backups/` 是保护根），也无其它回收路径。现在把每个备份子目录纳入扫描，只清精确形态的原子写中间档（备份本体不受影响）。

### 修复（P3）

- **空 `global/` 目录被误报「清理中断，完整性未确认」**：全新安装后 global 为空，恢复失败时消息让用户对一个空目录「切勿删除」。现在三态分开如实说明：清理中断 / 已保留（非空）/ 恢复前为空（无可恢复内容，可直接删除）。
- **`clipLinesToChars` 病态判据漏形态 + 提示行不计预算**：旧判据只在「单行真的超预算」时报，实测 2199 字符（未超 2200）或 `kept=2` 时零提示，而仍被挤掉 7-8 条。现在改用「保下来的行平均长度 ≥ 丢弃行的 3 倍」判据（等长行正常裁剪不误报），并把提示行长度从 `perCategoryChars` 里预留（此前单类可达 3086 字符 / 预算 2200）。
- **日期式命名 `report.tmp-2026-10-22` 被当孤儿删**：判定从 `\.tmp-\d+-\d+` 收紧到「pid + 13 位毫秒时间戳」（2xxx 年），与仓库内所有真实 tmp 命名（`${pid}-${Date.now()}`）一致，用户手建的日期式名字不再误删。
- **`evictedNote` 的「退条目」分支无任何测试**：新增 `retreated` 可观测量并从 `buildArtifact` 返回，便于面板/测试观测该防御分支是否生效。

### 测试

- **补上检查点名的最大空白：memo 链路端到端**。此前 compile 端点只测「回调被调用」（计数），`runtimeMemo.clear()` 只有一条源码正则——**影子 Map / `clear()` 变空操作 / 失效函数整体空转三种退化都能全部通过**。现在新增：真实插件实例 + 同一 TTL 窗口内连做两次注入、中间触发 compile，验证第二次必须看到新内容（实测该测试对 `onRuntimeCompiled` 变空操作敏感）。
- 其余新增测试：P0-A 撞名 2 条 + 反向（普通名不加后缀）、P0-B 双向 2 条、P2-a 不变量扫描、P2-b 幽灵计数、P2-c 成功清理 / 失败保留 2 条、P2-d 双写 2 条、P3-a 空目录消息、P3-b 3 条、P3-c/d 3 条。测试总数 1067 → 1087。

### 已知取舍

- `retreated` 这条防御分支在本机可构造的参数空间内**不可达**（`includedRest` 为空或空间充足时都不会进入），保留它是为了「只要退过条目必留痕」这条逻辑不变量；已在代码注释与 CHANGELOG 如实说明，不假装它被参数级测试覆盖。
- 单行本身超预算时（如 3000 字符的近期活动描述），提示行预留也无法让单类落回预算内——这是物理限制，靠外层 `truncateWithWarning(120, 12000)` 总闸兜底。

## [0.6.3] - 2026-10-22

P2/P3 收尾批：把 v0.6.2 检查里「提出但未动」的 9 项全部处理完，另补 3 处测试。共 2 项数据保全、3 项并发安全、4 项可观测/文案，无新增开关、`FORMAT_VERSION` 仍为 2。

### 修复

- **同一批既有 global 又有 project 破坏性写时，两份手术快照互杀**：两侧各建一份预映像、各 prune 一次；`surgicalKeep` 调小（如 1）时后一次 prune 把前一次刚建的顶掉——用户在面板「快照」页只剩一份，另一侧覆盖后无法回滚。现在 `pruneSurgicalSnapshots` 接受 `protectIds`，本批新建的 id 全部豁免（且豁免项不占保留名额）。
- **整份备份恢复的半途态丢掉全局回滚材料**：`global` 段换入成功后立刻 `cleanupRetired`，若随后 `projects` 段失败，恢复前的全局数据已被删——回滚无材料，而错误消息还宣称「已保留」。现在清理统一挪到「两段都换入成功之后」；任一段失败都保留全部 `retired-*`，消息按现场核对如实报告「已保留」或「完整性未确认」。
- **启动清扫会误删其它实例正在写的临时档**：`.tmp-<pid>-<ts>` 分支原为无条件删除。两个实例共用同一 `storageRoot`（web + desktop）时，后启动者的清扫把前者在途写入的 tmp 删掉 → 前者 rename 抛 `ENOENT`，全局写随机失败且不可复现。现在与 `*.tmp` 分支同用「mtime 超 1 小时才清」的到龄判据（在途 tmp 的 mtime 必然是新的）；红线名字与留档区照旧跳过。
- **清扫把用户手建的 `<名>.tmp-notes.md` 当孤儿删掉**：判定从 `includes(".tmp-")` 收紧为精确形态 `\.tmp-\d+-\d+(-[a-z0-9]+)?$`（只认原子写中间档）。
- **单行超长会把同类其它索引行挤掉且无任何提示**：每类字符预算裁剪是「从尾部往前装、装不下即停」，若某条索引行本身超预算，保它就必然丢掉前面所有能装下的行——用户看到某分类只剩 1 条、面板里却有 8 条，无从解释。现在该病态情形会追加一行可见提示（`另有 N 条因单条过长未进注入…`）；正常裁剪不出现该行。
- **`redactOps` 不覆盖 `name` 字段**：模型可以把密钥片段写进文件名（`sk-abc….md`），而文件名会落盘、进 `MEMORY.md` 索引、进提取 manifest、并随每轮注入进模型视野——比正文里的密钥更持久。`sanitizeMemoryName` 只做字符白名单，不拦这种形态。现在 `name` 与正文同口径脱敏。
- **`abandoned` 行无上限，主档长期膨胀**：放弃区间原「永不裁」，`protectedCount` 越大触发线越高，但每次轮转仍是整档读 + 整档写，轮转成本随 abandon 次数线性上涨。现在盘上只留最近 200 条 abandoned 行；被裁掉的数量写进 `extraction-journal.jsonl.abandoned-truncated.json`（sidecar），保证「已放弃 N 轮」跨重启不缩水。
- **`firstSeenAt` 字段名与语义不符**：它从不记录「首次出现」，每次编译都写成当次 `compiledAt`，排障时会让人误以为「这条候选今天才出现」。改名为 **`lastSeenAt`**（`runtime.json.evictCandidates[].lastSeenAt`），契约 §四 同步。该字段无面板消费方，改名无兼容层。
- **面板对「尚未编译」的文案像报错**：读到 `E_NO_ARTIFACTS` 时会把 `无编译产物（scope …）` 直接拼在「未能读取产物：」后面，读成「未能读取产物：无编译产物」，绕且像故障。现在按 code 分流：未编译过属正常初态，给「点上方『重新编译』立即生成」的人话引导；真错误仍如实显示服务端 message 与排查建议。

### 测试

- **`writeEntryDirect` 的 origin 保留补测试**：v0.6.2 修了「归档 origin 三字段被普通编辑剥掉」，但 `writeEntryDirect`（导入覆盖 / 提取覆写全局走它）当时无测试——摘掉其 origin 保留测试仍全部通过（独立检查实测 M5' 存活）。现补 2 条（保留 + 非归档分类不凭空长出）。
- **`runtimeMemo.clear()` 从源码正则改为行为测试**：此前只有 `assert.match(src, /runtimeMemo\.clear\(\)/)`——把语句删掉或挪进永不执行的分支，正则仍绿而行为已坏（M16d 存活）。现按设计承诺测两件事：TTL 窗口内结果稳定不抖动、越过 TTL 必须看到盘上新内容（记忆会过期而非永久钉死）。
- **删掉一条 `|| true` 恒真死断言**：`restoreBackup` 用例里对 `compile-journal.jsonl` 的检查原本恒真（等于没测）。改为真实断言：scope 目录失效不删 runtime 根下的编译观测日志。

### 已知取舍

- 归档审计保留 2500 行而快照只留 10 份，第 11 份以前的审计行其 `snapshot` 字段会指向已轮转清理的目录。**不丢记忆**（`long-term` 归档副本仍是活真源），只是少了手术式快照那层保险；面板不展示审计记录，故无 UI 误导面（已在 `RUNTIME-FORMAT.md` §6.2-9 写明）。

## [0.6.2] - 2026-10-22

五路独立检查（运行时记忆层 / 核心记忆管线 / 公开面泄露与文档漂移 / 测试自证式审查 / 0.6.1 修复真实性复查）后的一轮修复批。修掉 7 个真实缺陷——其中 2 个会让**记忆对注入面静默消失**、2 个会让**用户按面板指引做完全无效的操作**——并补强 2 处**失效的测试**（0.6.1 声称「11 项变异全部被抓住」，实测 3 项存活）。无新增开关、无存储格式变更（`FORMAT_VERSION` 仍为 2）。

### 修复（按影响面排序）

- **同一批里「先删后写」同一条记忆 → 索引行被清空（记忆对注入面静默消失）**：提取落盘的终态对账假定「delete 是最后动作」，但模型给的 op 是数组序。模型在同一批里先删后改某条记忆（「忘掉旧结论、换成新结论」的常见形态）时，文件由 write 正常落盘、`MEMORY.md` 那一行却被 `deletedNames` 剔掉——此后每轮注入都看不到它，而面板文件列表照旧列着它（用户与模型各看到一半）。现在终态改为按「该 name 在本批 ops 里**最后一次出现的 action**」判定：末次 delete 才剔索引行，末次 write 则保留（含 write→delete→write 这类三连）。仅项目侧受影响，全局侧本就逐 op 即时重建索引。
- **全局记忆覆盖写没有硬事实比对（数字改错零留痕）**：`hardfactWritebackReport` 此前只挂在项目侧提取落盘上——全局四分类（`user-profile` / `work-profile` / `current-focus` / `long-term`）的覆盖写完全不比对，模型把全局记忆里的「端口 8443」记成「8434」既无告警也无日志，`/state.safety.hardfactDrops` 对全局恒 0，`hardfactPolicy: "block"` 对全局也不生效。而全局恰是跨项目、影响面最大的一层。现在全局写后校验通过后走同一判据：检出即计 `hardfactDrops` + 把 diff 片段落 `extraction-errors.log`；`block` 策略下按写后校验失败同一收口回滚（计 `hardfactBlocks`，与 `verifyFailed` 分列），回滚后索引按批前原文对账。
- **嵌套条目的 `frontmatter.name` 被展平，制造幽灵文件与双份记忆**：`renderMemoryFile` 落盘时把 `sub/nested.md` 的 `name` 写成 `sub-nested`（剥掉斜杠），而文件仍在 `sub/nested.md`。manifest 行按 `front.name` 回填，模型下轮据此覆盖写时会新建一份 `sub-nested.md`、原文件原地不动——一条记忆两份文件、两份索引行、两份注入。现在 `name` 保留真实相对路径（`sanitizeMemoryName` 本就支持 ≤4 层嵌套），manifest 回写 / 索引链接 / pin 透传全部闭环；写后校验的 `expectedName` 同口径改为真实相对路径（否则嵌套条目会被误判「name 与文件名不一致」而回滚）。pin 端点同样只改 `pinned`、原样透传 `name`。
- **pinned 撑爆配额时的淘汰候选误导用户做无效操作**：pinned 合计超配额时，所有非 pinned 条目未经任何「装不下」竞争即落选，却被统一登记为 `reason: "quota"`——面板据此引导用户去归档这些普通条目，而归档后下一轮**照样 overQuota**（pinned 一条没少）、候选清单原样复现，操作永远无效且无可解释性。现在分两种 reason：`quota`（真淘汰）与 `pinned-overflow`（pinned 撑爆，先解 pin），面板文案对应「关键条目超配额（先解 pin）」。同时修掉 pinnedOver 时淘汰提示行被静默丢弃的问题——产物已必然超配额，此时提示行的信息价值高于字节自律，无条件写入（否则面板有 N 条候选、产物里一句不提）。
- **面板点「重新编译」后 2 秒内注入仍拿到旧产物**：`pin`/`evict`/`restore` 三端点走 `onGlobalWrite({runtimeHandled:true})` 清进程内 memo，但 `compile` / `compile-all` 只换产物、不动记忆目录、不经 `onGlobalWrite`，早先因此漏清。现在 `makeApiRoutes` 新增 `onRuntimeCompiled` 回调（接线层实现为 `runtimeMemo.clear()`，不走 `onGlobalWrite` 以免触发滚动清理），两个 compile 端点成功后都调用它。
- **项目条目 frontmatter 的 `\r` 转义漏了一处渲染器**：0.6.1 声称「两处渲染器的换行转义已统一为 `[\r\n]+`」，实际三个渲染器只改了 2 个——`renderMemoryFile`（项目条目写盘路径，pin 端点也复用它）仍是 `/\n/g`。裸 `\r` 会让 frontmatter 撑出跨行、读侧静默截断 `description`。现已统一，并补了覆盖三种渲染器的断言。
- **索引重建失败会把「文件写了、索引没更新」静默吞掉**：`applyOps` 的 `MEMORY.md` 重建（`writeFileSync` + `renameSync`）原本在 per-op try/catch 之外，磁盘满/权限拒绝时整批记忆文件已落盘、索引却停在旧态，且调用方仍报 ok。现在单独收口：失败计 `failed` 并记 error 日志（非静默），已落盘文件保留、靠下轮 manifest 自愈。

### 文档

- README 中英双版的安装命令此前硬编码 `v0.6.1.tar.gz`，而远端只有 v0.1.0/v0.2.0/v0.3.0/v0.3.1 四个 tag（`git ls-remote --tags` 实测）——用户照首屏复制即 404。现改为带引号的版本占位 `".../tags/v<版本号>.tar.gz"` 并注明「版本号见 Releases」，避免每次发版都要改文档。
- README 中英双版版本号 0.6.0 → 0.6.2（对齐 `package.json`）。

### 测试

- **修掉一条自证式回归测试**：`runtime-regress` 的「只读态 stale 清单」用例此前用 `compileScope()`（纯内存编译、不写 `runtime.json`），于是注入侧走的是「无缓存」早退分支，**被测的指纹比对代码根本没执行**——删掉该守卫测试仍然全部通过（实测）。改用 `ensureCompiled()` 让清单真落盘后，删守卫即变红。
- **补上配额预留的测试**：0.6.1 把「淘汰提示行事后追加」改成「装填时预留字节」，但没有测试钉它——恢复旧实现仍然全部通过（实测能构造出 `bytes=10283 > quota=10240` 却 `status=ok`）。新增边界扫描用例（10 组不同条目宽度），任一处越界即红。
- 新增 `pin-name-stability`（4 条）、`runtime-compile-memo`（4 条）两个测试文件，以及全局硬事实比对 3 条、pinnedOver reason 2 条、delete→write 终态 2 条、`renderMemoryFile` 换行转义 1 条。测试总数 1035 → 1053。

### 已知取舍

- **嵌套条目的历史数据**：0.6.2 起新写入的嵌套条目 `name` 是真实相对路径，manifest 回写不会分叉。但**旧版写入的嵌套条目**其 `name` 仍是展平形态，模型若按旧 manifest 名（`sub-nested`）覆盖写，会新建一份扁平文件而非更新原文件（旧文件保留、不丢数据，面板可看到两个条目）。未加「展平名消解」自动兼容——那会在「恰好新增一条叫 `sub-nested` 的条目」时误判为覆盖，引入更难查的问题；如需整理，在面板手工合并即可。
- 归档快照 `backups/evict-*` 保留 10 份而审计日志保留 2500 行，早期归档的审计行 `snapshot` 字段会指向已轮转清理的目录（long-term 副本仍是活的，不丢记忆，只是少一层保险）。

## [0.6.1] - 2026-10-21

运行时记忆层的**缺陷修复批**：三路独立检查 + 逐条实测复现后，修掉 2 个会真正丢记忆可见性的缺陷（写入后面板 404、被淘汰条目两头不可见）、1 个会把记忆静默清空的读失败路径，以及 4 个一致性问题（面板开关状态谎报、归档可逆被普通编辑破坏、审计中断静默丢候选、文档与实现漂移）。无新增开关、无格式变更（`FORMAT_VERSION` 仍为 2）。

### 修复（按影响面排序）

- **runtime 端点成功后产物被自己删掉**：`pin` / `evict` / `restore` 三个端点在内部已按受影响 scope 失效并重编，返回前又走了一次统一的写后失效（清全部 `runtime/<scope>/`），把刚编好的产物整个删掉——面板随后 `GET runtime/<scope>` 直接 404，淘汰候选清单、pin 状态、用量条全部清空，直到下一次注入或手动重编才自愈。现在这三个端点向接线层传 `runtimeHandled` 标记，跳过二次全清；其它写路径（保存条目、人设、备份恢复等）的全失效照旧。
- **被配额淘汰的条目两头不可见**：顺序装填装不下即停后，这些条目只进了 `evictCandidates[]`；而 globalIndex 去重当时是「产物 status=ok → 三分类整类移除」，于是没进产物的条目既不在 runtime 段、也不在索引里，产物内还没有任何提示。现在：①产物末尾追加 `[runtime evicted: N entries exceed …]` 可见行（与 `overQuota` 分开——淘汰是设计内行为，不算超配额）；②去重改为**分类粒度**：只有该分类的条目**全部**进了产物才从索引移除，任一条被淘汰则该分类继续渲染。只读闸用缓存文本时同样按清单自身的选条结果判定，不假定全覆盖。
- **候选池读失败被当成"分类空了"**：`readdir`/`readFile` 失败（权限、IO、句柄占用）此前一律静默返回空，编译"成功"并写出空产物覆盖上一版好产物——一次瞬时错误就等于静默清空该分类记忆。现在只有 `ENOENT`（目录/文件不存在）按空处理，其余失败上抛 → `status=error` + 保留上一版产物 + 注入侧可见降级。指纹计算也纳入同一条 try，不再绕过降级路径直接抛给调用方。
- **`/state.settings` 缺 `runtimeEnabled`，面板开关谎报**：`settingsForClient` 没有输出该字段，面板只能靠本会话 PUT 成功后的本地回填写；刷新页面后即使盘上是开启的，设置页开关仍显示"关闭"、运行时页也继续给"默认关闭"的引导文案。现已补进出参（读侧口径与 `settings.js` 一致：只有显式 `true` 才算开）。
- **归档可逆性被普通编辑破坏**：`long-term` 归档条目带 `originProject` / `originType` / `originSessionId` 三字段，但面板编辑（`updateEntry`）与提取/导入覆写（`writeEntryDirect`）都走 `renderGlobalEntry`，而它不认识这三个字段——覆写一次就剥掉，之后「从归档移回」恒 400。现已在渲染器加可选 `origin` 参数，两条覆写路径对 `long-term` 条目从原文保留 origin（非归档条目不会凭空长出这些字段）。
- **归档审计写失败时余下候选静默失踪**：审计追加抛错会让整个循环中断——已搬完的那条源已删、副本已写，但响应是泛化 500，余下合法候选既不入 `archived` 也不进 `skipped[]`，第 7 步的失效重编与快照滚动清理也不执行。现在审计失败后**停止继续搬运**（后续条目不再动源文件），但走完失效重编与滚动清理，再把 `archived` / `skipped[reason=audit-failed]` / `snapshotDir` 随 `EVICT_AUDIT_FAILED` 带回，HTTP 层据此报「已归档 N 条 / 未处理 M 条」而不是一句"服务端内部错误"。
- **pin 端点缺锁**：`pin` 是「读原文 → 只改 `pinned` → 整体覆写」，与提取覆写并发时后写者会覆盖前者的正文，而它此前不像 `evict` / `restore` / 保存条目那样抢提取批互斥锁（也无手术式快照）。现与同类写端点同口径：拿不到锁回 409。
- **`section` 模式在 `projectMemory=false` 时仍每轮编译写盘**：usage 段的 runtime 告警取值只判 `runtimeEnabled`，漏了 `projectMemory`，导致产物永不被注入却每轮算指纹、可能写盘。判据已与 runtime 两段严格同口径。
- **项目条目双份注入**：项目条目已编译进 scope 产物，`projectIndex` 段又整份渲染项目 `MEMORY.md`，同一事实出现两遍、预算双倍占用。现在按「该条目已进产物」逐行剔除；`reference` 类型（不进产物）与被淘汰的条目**照旧留在索引**——去重不等于让条目消失。
- **极小预算下发零内容空壳块**：`0 < maxChars < 固定开销`（包裹符 + 取代声明 + 免责行 + 告警行）时，锁定段被截空后仍会返回一个不含任何记忆的 500 字符块，绕开了「不发空壳」的意图。现在内容段全空即返回空文本（与 `maxChars<=0` 的不注入口径对齐）。
- **overQuota 指引不可执行**：面板文案说「调高配额需改配置文件」，但配额是编译期常量（`RUNTIME_QUOTAS`），配置改不到。已订正文案为真能做的三件事（解 pin / 精简条目 / 归档到 long-term），解 pin 预警文案同步。

### 检查后补修（第二轮独立复查发现，含本次修复自身引入的缺陷）

- **【P0，本批引入】审计失败时已搬走的条目被谎报为「已跳过」**：上一轮把中断改成了「停止搬运但走完流程」，但守卫写在了快照/写副本/删源**之后**——于是第 2..N 条其实已经搬完（源已删、副本已写）却被记进 `skipped[audit-failed]`，进度谎报。守卫已移到循环体**最前面**：审计坏掉后后续条目一个都不动，源文件原样留在原位。
- **【P1，本批引入】淘汰提示行不计入配额**：`[runtime evicted: N …]` 是事后追加的，装填时没占额度，导致产物可能 `bytes > quota` 却仍 `status=ok`（实测 4102/4096），面板出现「用量条爆红 + 状态绿灯」的自相矛盾。现在提示行按配额预留：放不下先降级成短行（`[runtime evicted: N over quota; see keepsake panel]`），短行仍放不下才退条目——**记忆内容优先于提示的详细程度**。
- **【P1，本批引入】只读态把陈旧清单当真**：降级期间新增的条目不在旧清单里，而注入侧照旧按清单判「三分类全覆盖」整类去重，新条目仍然两头不可见。现在只读态先比对清单 `sourceHash` 与盘上候选池指纹，一致才信任覆盖集，不一致就保守不做去重（索引照旧渲染），usage 记 `[runtime readOnly, stale artifacts: index not deduplicated]`。
- **普通条目移入 long-term 时补写 origin**：此前只有「淘汰归档」会写 origin，手工/面板把条目移进归档区则没有出处记录，日后「从归档移回」恒 400。现在移入时记下原分类（`createEntry` 支持 `origin` 参数，一次写盘带齐，不做「先建后补写」）。
- **runtimeHandled 端点也清进程内 memo**：跳过二次全失效会让注入侧最长 2 秒仍拿到旧文本与旧覆盖集，与盘上新产物打架。现在产物不动、memo 照清。
- **frontmatter 转义补 `\r`**：`esc` 只压 `\n`，值里带单独的回车会在 frontmatter 里撑出跨行字段（读侧只取首行 = 静默截断）。两处渲染器的口径已统一为 `[\r\n]+`。
  > 订正（0.6.2）：本批实际只覆盖了 `renderGlobalEntry` 与 `renderArchivedEntry` 两处，**`renderMemoryFile`（项目条目写盘路径，pin 端点亦复用）漏改**；该处已在 0.6.2 补齐。
- **只剩省略号的块也算空**：`maxChars` 恰好只够截出 `…` 时，此前会返回含 intro + 提示行却不含任何记忆的块；现在判空连 `…` 一并算空（实测逐预算扫描 401..470 全部干净）。
- **面板展示归档半完成态明细**：`api()` 把响应体挂到 `Error.details`，归档失败时页内列出「哪几条没动、快照在哪」，不再只有一句不知道发生了什么的话；`audit-failed` 补了人话文案。

### 测试

- 新增 `test/runtime-regress.test.mjs`（12 条），逐条钉住上述修复：淘汰留痕、分类粒度去重（含只读态指纹校验双向）、读失败降级、pin 后产物仍在（走 `apply()` 真实接线并反向钉住普通写路径照常全失效）、origin 透传 + 真跑一次移回、移入 long-term 补 origin、`settings.runtimeEnabled` 契约、项目条目去重（走真实注入链路，`reference` 仍在索引）、小预算空壳（含 401..470 逐预算扫描）、审计中断如实回报（并验证被跳过条目的源文件确实没动）。
- **拆改验证**：把 11 个修复点逐条关掉后重跑全量测试，**11/11 全部变红**（0 存活）——确保这些测试真的能抓住对应回归，而不是同义反复。
- 修正一条随时间流逝必红的测试：`runtimeRestoreRows` 现在接受 `now` 入参，`panel-logic.test.mjs` 传入固定时刻（此前用 `Date.now()` 默认值，跑在"1 小时前"数据上跨过一天就变成「1 天前」）。
- 同步更新受行为变更影响的既有测试（`/state.settings` 出参契约、项目索引去重、极小预算空壳、面板 `api()` 结构钉改为允许挂 details 但仍钉住「message 优先、error 回落」）。
- 质量关：`npm run check` + `npm test` → **1035 项全部通过**（0.6.0 为 1023 项）。
- 现网数据复验（复制 `~/.dsh/memory` 到临时目录，不碰真数据）：3 个 scope 全部 `bytes ≤ quota`；有 48 条淘汰候选的那个项目产物带提示行且 10236/10240 恰好不越界；覆盖分类正确退出索引；26 条项目条目将按「已进产物」剔重。

### 回滚

- 本版无新增开关，回滚 = 装回 0.6.0；数据格式未变（`FORMAT_VERSION` 仍是 2），**无需迁移、无需备份**。
- 只想退回某一项行为时没有独立开关（都是缺陷修复，不是可选特性）；其中影响面最大的是「分类粒度去重」与「淘汰留痕行」，二者都只会让内容**更可见**，不会减少注入内容。

## [0.6.0] - 2026-10-20

运行时记忆层：把条目文件**编译**成定长的 `USER.md`（≤4KB）/ `MEMORY.md`（≤10KB），随每轮注入，替代"只给索引、靠模型按需 Read"。默认**关**（`runtimeEnabled`，规矩：开关默认关、可回滚）；开启后注入由四段变六段。另有两项预算切分（persona 上限 8000 字符、`injectMaxTokens` 24000）与一项索引面变化（long-term 退出注入索引）。格式层只增可选字段，`FORMAT_VERSION` 1→2。

### 新增
- **运行时记忆层（`runtimeEnabled`，默认关；面板「设置」页开关）**：L0 = 每轮注入的紧凑记忆。编译规则——pinned（`pinned: true`）条目全部优先入选、剩余额度按「权重 desc, mtimeMs desc」顺序装填、装不下即停；配额 **USER.md ≤ 4096 字节 / MEMORY.md ≤ 10240 字节**（UTF-8 字节口径，含文件头声明与告警行）。候选池 = 全局分类 + 当前项目条目（`long-term` / `recent-activity` 不进、`reference` 不入正文）。
- **编译产物与清单**：`<storageRoot>/runtime/<scope>/`（`global` 与 `projects/<slug>-<hash16>` 各一份）落 `USER.md` / `MEMORY.md` / `runtime.json`。`runtime.json` 记选条明细（`entries[]` 含 `pinned` / `included` / `bytes`）、`status`（`ok` / `overQuota` / `error`）、`sourceHash`（候选池路径+mtimeMs+size+配额+算法版本）与 `evictCandidates[]`；同输入同产物（确定性编译）。**产物不是真源**：整目录可删可重建，手工修改会被下次编译覆盖。
- **`pin`（「关键」）**：条目 frontmatter 可选 `pinned: true`（全局与项目条目皆可）。pinned 条目在候选池内永不淘汰、优先入选；合计超配额时**不截断、不静默**——`status=overQuota` + 面板红灯 + 注入块内告警行。五条覆写路径（面板保存 / 提取覆写 / 导入覆盖 / pin 端点 / 归档重写）均透传 `pinned`（有 roundtrip 测试钉死）。
- **淘汰候选 + 面板确认归档**：编译只**登记**候选（`runtime.json.evictCandidates`），绝不搬文件；用户在面板「运行时记忆」页勾选后点「执行归档」才落盘。执行序列：抢 `extract.lock`（被占 409）→ 逐条核对仍为候选（过期项进响应 `skipped[]`）→ **手术式快照**到 `backups/evict-<ts>/<n>-<name>`（只快照被搬文件，保留最近 10 份）→ 按 long-term 扩展 schema 重写进 `global/long-term/`（`originProject` / `originType` / `originSessionId` 三字段承载出处）→ 索引对账 → **持久审计** `evict-audit.jsonl` 追加一行（5000 行轮转留尾 2500，不随 `runtime/` 清理）→ 失效并全量重编受影响 scope。**归档 ≠ 删除**，可逆：面板「从归档移回」按 origin 三字段落回原位（`POST runtime/global/archive/restore`），快照与审计留档。
- **面板「运行时记忆」页签**：scope 切换（全局 / 各项目）、`USER.md` / `MEMORY.md` 只读预览、字节用量进度条（越界红显）、淘汰候选列表（勾选 + 执行归档 + 计数徽标）、「重新编译」、从归档移回；开关关闭时给一句引导文案。执行归档前自动刷新候选清单。
- **runtime API 六端点**：`GET runtime/<scope>`（只读产物与清单）、`POST runtime/<scope>/compile`、`POST runtime/compile-all`、`POST runtime/<scope>/pin`、`POST runtime/<scope>/evict`、`POST runtime/global/archive/restore`。scope 值含斜杠，走专用匹配 `matchRuntime`；scope 不存在 404、参数非法 400、锁被占 409、编译失败 500（保留上一版产物）。
- **`compile-journal.jsonl`**：每次编译一行（`trigger` / `selected` / `candidates` / `overQuota` / `bytes` / `sourceHash`），独立实现（不复用 `journal.js` 的会话语义），达 2000 行轮转留尾 1000。

### 变更（升级前请读）
- **① long-term 归档区退出注入索引**：全局索引不再渲染 `long-term` 分类——归档区条目不再注入任何会话，顺带修掉「归档条目跨项目外溢」；`runtimeEnabled` 关着也生效（不依赖产物状态）。唯一例外是**提取 prompt**（`renderGlobalIndex({includeArchived:true})`）：模型仍看得见归档区，避免重复造已归档条目。此项使「无 runtime 数据时输出与 0.5.0 逐字节一致」不再成立，回归门改为内容集合等价（差异白名单=long-term 索引行）。
- **② persona 段上限 16000 → 8000 字符**（行数仍 400）：为 runtime 两段腾预算；8000 字符 ≈12000 tokens。超限照旧截断并附可见 WARNING。
- **③ `injectMaxTokens` 默认 16000 → 24000**：口径切分为「persona ≈12000 + runtime 常驻 ≈7170 ≈ 19170 < 24000」，留出余量；`injectMaxChars` 仍为 30000（字符口径：8000 + 4779 ≈ 12779）。两项默认值在代码与 `cordis.patch.yml` 同步，显式配置可覆盖。
- **④ `runtimeEnabled` 新开关，默认关**：关闭时——不编译、不注入 runtime 两段、`globalIndex` 的 runtime 去重不生效（`user-profile` / `work-profile` / `current-focus` 照旧渲染）。开启后才生效；`conversationMemory` / `projectMemory` 关掉时 runtime 两段一并停注（保守口径）。
- **⑤ `FORMAT_VERSION` 1 → 2**：新增可选 `pinned` 与 long-term 可选 origin 三字段，**无数据迁移**（启动只补写标记，不改写任何文件）。旧版插件读到 v2 标记自动转只读——这是「降级后旧版覆写剥掉 pin」的兜底防线。
- **注入段序**：`persona → runtimeUser → runtimeMemory → globalIndex → usage → projectIndex`（原四段相对顺序不动，usage 不前移，runtime 两段插在 persona 与 globalIndex 之间）；`persona` / `runtimeUser` / `runtimeMemory` 为**锁定段**，不进丢弃序列，兜底截断优先级 persona > runtimeUser > runtimeMemory，每次截断带告警行。`section` 模式同序承载（4992 / 4993）。

### 修复
- **文档**：`FORMAT.md` 第七节订正「面板手动删除不进回收站」的过时句——v0.4.1 起面板「删除条目」（`DELETE /entry`）与自动提取删除同口径，均移入回收站（分类重置与近期动态滚动清理仍是直接删除）；同节补 `runtime/`、`evict-audit.jsonl`、`backups/evict-<ts>/` 的非真源语义。
- **文档**：`FORMAT.md` 第八节「`FORMAT_VERSION` 自 v0.3.0 起未再变化」订正为「v0.3.0 → v0.5.0 一直为 1，本版起为 2」，并登记 v1→v2 迁移位。

### 回滚
- **整层回退**：`runtimeEnabled=false`（或删掉 `settings.json` 里的该键）即回到 L0 不注入——不编译、不注 runtime 两段，其余功能不受影响；已产生的 `runtime/` 产物可整目录删除，不影响任何记忆。
- **预算回退**：persona 上限与 `injectMaxTokens` 是代码默认值，无需配置即随版本变化；若要回到旧口径，显式配置 `injectMaxTokens: 16000` 即可（persona 8000 上限为编译期常量，回退需回旧版本）。
- **格式回退**：`FORMAT_VERSION=2` 对旧版是只读闸；回旧版本前先做全量备份。v2 只新增可选字段，旧版读取不受影响。

## [0.5.0] - 2026-10-17

安全与成本收敛：密钥类内容默认脱敏；失败区间自动补提收口；注入加 token 预算；提取触发加打分门、空闲延迟与每会话上限。四项全部默认开启，各有独立回滚开关；测试全部通过。

### 新增
- **内容脱敏（默认开，`redactionEnabled`）**：两道位置拦截密钥类内容——①提取提示词之前，会话摘录在用户消息 / 助手回复 / 工具调用 / 工具结果四处渲染时先脱敏后截断（防截断把密钥切半导致漏检）；②落盘之前，提取产出的写入/删除操作再过一道脱敏（纵深防御，只动内容字段，不动文件名 / 路径 / 条目标识 / 操作类型）。内置 **7 类固定模式**：私钥块、Authorization 头凭据、独立 Bearer/Basic 令牌、常见厂商密钥形态（`sk-`、GitHub PAT、AWS Access Key、Slack 令牌、Google API Key、JWT）、URL 内嵌凭据、敏感键值赋值（`password` / `secret` / `token` / `api_key` / `private_key` / `credentials` 等）、内网 IPv4（`10.x` / `172.16-31.x` / `192.168.x`）。命中共计进提取运行日志行的 `redacted` 字段（>0 才写）。占位符 `[redacted]`，重复执行幂等；模式清单固定、不支持用户自定义正则（防正则回溯）。`redactionEnabled: false` 完全关闭、回旧行为。
- **失败区间自动补提收口（默认开，`autoRecoverEnabled`）**：手动补提按钮之外，三个时机自动补提未恢复的失败区间——会话关闭（`session/disposed`，限该会话）、轮次完成（`turn/end`，全局清扫）、插件装载后数秒（启动清扫，跨重启续提闭环）。只补 kind=failed，已显式放弃（abandoned）的区间绝不自动重试；同一区间两次尝试之间有冷却间隔（`autoRecoverCooldownMs`，默认 300000 毫秒）；与手动按钮共用单飞锁，互斥不并发；宿主无会话持久化时静默不跑（能力缺失不是故障）。`/state.recover` 增 `autoEnabled` / `autoAttempts` / `lastAutoAt` / `lastAutoTrigger` 四键。
- **注入 token 预算（默认 16000，`injectMaxTokens`，0=关）**：注入总预算在字符口径（`injectMaxChars`，默认 30000）之外增加 CJK 感知 token 口径，双上限同时生效取更严者；召回块计入总预算、主块为召回块让位（召回块自身不做裁剪，与字符口径语义一致）；`0 = 关闭 token 预算`，行为与字符口径逐字节一致。token 估算是码点级近似（CJK/全角字 ≈1.5 token/字，其余 ≈0.25 token/字），非精确分词。`/state` 顶层增 `injectMaxTokens`，`injection` 增 `lastTokens` / `totalTokens`；面板健康卡注入摘要显示「最近 ≈X tokens / 上限 Y」（0 时退回字符展示）。
- **提取触发门槛（默认开，`extractGateEnabled`）**：提取前对区间打分——`分数 = 用户词数 + 2×工具种类数 + 2×真人轮次数`，低于阈值（`extractGateMinScore`，默认 6）不调模型、记 `skipped/thin-evidence`，进度照常推进、运行日志留痕。配套两道成本闸：**空闲延迟**（`extractIdleDelayMs`，默认 3000 毫秒，0=立即；轮次完成后延迟起跑、合并突发轮次为一次提取，定时为固定时刻不滑动，会话关闭 / 插件退出时挂起提取立即收口不丢）；**每会话上限**（`extractMaxRunsPerSession`，默认 50，0=不限；到顶后记 `skipped/session-cap` 并推进进度，不再调模型，只约束自动链路、手动补提不受限）。`/state.extractionConfig` 增 `gateEnabled` / `gateMinScore` / `idleDelayMs` / `maxRunsPerSession` / `redactionEnabled` 五键。

### 变更
- `cordis.patch.yml` 样例 `injectMaxChars` 由 60000 改为 30000，修复样例与代码及文档默认值的漂移（代码默认本就是 30000，本版只改样例；校验语义不变）。
- 注入块预算从单字符口径变为字符 + token 双口径（默认值变化：CJK 长块会被裁得比以前短——这是修复挤爆上下文的隐患）；其余注入行为（丢弃顺序 / 取代声明 / 节流 / 兜底截断）不变。
- 配置校验新增非负整数校验器（`injectMaxTokens` / `extractIdleDelayMs` / `extractMaxRunsPerSession` 允许 0）；`autoRecoverCooldownMs` / `extractIdleDelayMs` 受定时器最大延迟上限约束，超限启动即抛。

## [0.4.2] - 2026-10-17

注入面收敛与运维补齐：宿主历史只能追加、旧注入块撤不回，本版给注入补上「同源替换」三件套（取代声明 + 变更节流 + 观测计数）；把跨重启补提从「看得见」推进到「补得上」；面板新增记忆整理建议；并把「机器来源」判据泛化到任意插件。

### 新增
- **会话补提（跨重启把失败区间读回来重提）**：面板「补提」区列出未恢复 / 已放弃的提取区间（数据源是提取运行日志，持久留痕、跨重启可见），逐条可点「补提」重跑。前提是宿主提供会话持久化服务（本机宿主 0.2.0-rc.2 起内置）；旧版宿主如实降级提示（503 `E_HOST_UNSUPPORTED`），不假装补过。补提区间必须整体落在会话可读范围内——超出（含超大会话读回截断后的尾部）显式拒绝、区间留在清单里，绝不把没读到的部分按已补提记账。端点：`GET /api/sessions/pending`（清单 + 逐会话可读标记）、`POST /api/sessions/recover`（202 异步执行，结果经 `/state.recover` 观测；409 单飞 / 404 会话不在）。
- **记忆整理建议（设置页「记忆整理」卡）**：只出建议、不自动改动——①重复建议（正文高度重叠 / 跨分类同名 / 标题相近且正文重叠），列条目对与判断依据，留哪条由用户决定；②久未更新提醒（默认 90 天，修改时间缺失的条目如实标「年龄不可知」，不拿 0 天冒充）；③索引健康对账（悬挂行 / 漏登记 / 空分类）+「修复索引」按钮——只增删索引行、绝不删条目文件，改动前先把索引原文存进快照（留档失败即拒绝本次修复）。端点：`GET /api/maintenance/suggestions`、`POST /api/maintenance/repair-index`（响应 `fixed` 为已应用动作明细数组、`fixedCount`、`unchanged`）。
- **面板体验补齐**：条目列表分页（每页 50）；弹窗焦点陷阱（Tab 循环不逃逸）+ 关闭后还原焦点；错误提示条带 `alert` 角色（读屏立即播报）；设置页新增「N 项设置值不合法已回默认」黄条（数据源 `/state.settingsDiagnostics.coercedFields`，重存设置可修正）；注入观测新增「变更节流 N 次 / 取代 N 次」（`/state.injection.throttled` / `superseded`）。

### 变更
- **注入块同源替换**：每个注入块开头带一行取代声明（本块是最新记忆快照，作废此前同类块；视野里出现多块时只认最新）；记忆内容的小改被节流——正文相似度 ≥0.98 或字符差很小（≤ max(200, 全长 1%)）时先攒着不发，攒大了或上下文压缩把旧块挤出视野后再随全量块补发；相似度极低（<0.5）的整块改写直接放行。已知取舍：等长的小幅改写会被节流到下次大变更 / 压缩补发才进模型视野（取舍与局限见 README「已知限制」）。
- **防自食判据泛化**：提取门槛与摘录统一按「机器来源」排除——任意插件（不限本插件）的注入消息，以及 instruction / summary / tool 等系统性消息都不算用户话；真人消息（含无来源、steer / followup）照常计入门槛与摘录。语义召回的查询文本同样只取真人消息。README 中「只排除 plugin / plugin:*」的旧表述按此订正。
- **`injectMaxChars` 默认 60000 → 30000**：块首新增取代声明与免责两行固定开销，且节流要求"变化够大才补发"——预算越大，append-only 历史下每轮全量注入的字符越多；三万字符仍装得下四段完整内容。需要更大预算的显式配置 `injectMaxChars` 即可覆盖（校验语义不变）。
- **提取日志轮转按留痕价值裁剪**：裁剪时 skipped（跳过）类记录最先裁、zero-ops 次之，failed 与 abandoned 优先保留——长期关着总开关的会话（每轮记一条 skipped）不再把失败留痕挤出日志。
- **提取日志出列判据收紧**：未恢复区间只有被**整段覆盖**（后续记录的起点不晚于该区间起点、游标终点不早于区间终点）才算补上；此前只看游标终点，会把"从更晚处起提、尾巴伸过了终点"的区间误判成已补上、留痕凭空消失。

### 修复
- 设置值不合法落默认时记警告并暴露诊断字段（`/state.settingsDiagnostics.coercedFields`），重存设置可修正；
- 临时档清扫覆盖 `*.tmp` / `*.json.tmp` 等原子写中断残留（超 1 小时才清；`retired-*`、backups、snapshots、surgical、trash 等留档区永不碰）；
- 删除条目三态响应如实区分：不存在（`existed:false`）/ 已移入回收站（`trashed:true` + `trashId`）/ 存在但失败仍在原位（显式错误 + `existed:true`、`trashed:false`）；
- 文档补齐既有控件的说明：回收站 / 快照保留策略设置控件、设置页「清除已存 Key」按钮、四个分类页即时检索（标题 / 描述 / 正文即时过滤，每页 50 条分页）。

## [0.4.1] - 2026-10-16

根治「聊了几轮、keepsake 里看不出任何反馈」：成功/零产出/跳过此前全部不留痕、观测面是内存态（DSH 一重启归零）、失败区间跨重启永久丢失。

### 新增
- **提取运行日志（durable 观测面）**：新增 `<storageRoot>/extraction-journal.jsonl`，每次提取结算落一行——`written`（写/删几条、失败几条、过滤几条）/ `zero-ops`（模型无可记、或有 op 无可落盘）/ `skipped`（直写记忆、无有效用户发言、总开关关、格式只读）/ `failed`（与失败分桶同名的病因）。此前成功提取不留任何持久痕迹、失败详情只活在进程内存，重启即"零反馈"。追加串行化防并发写坏，行数超 2000 自动轮转留尾 1000；写失败只告警不阻断提取（可见降级，不静默放行）。
- **cursor 跨重启恢复**：每会话提取覆盖边界随日志持久化，DSH 重启后重开旧会话从上次边界**续提**——失败区间不再因重启永久丢失；从没提取过的会话仍不回扫历史（原设计保留）。
- **`/state` 新增 `extractionLog`**：`runs`（最近 30 条结算记录）+ `unrecovered`（失败且未被后续补上的区间）。
- **面板健康卡「最近提取记录」**：时间 + seq 范围 + 结果标签的折叠清单，每轮"为什么没记"有据可查；"未恢复区间"红条改双源——重启后回落盘侧未恢复清单，不再隐身。

### 变更
- **「直写过的轮次跳过自动提取」补 run_code 识别**：主 agent 在 run_code 里调 tools.write/edit 直写记忆目录此前识别不了（提取照跑还失败），与原生 edit 写法待遇不一致；现同口径识别。扫描前剥掉注释（注释里的示例代码不当真）收窄误识别面；判定仍是 best-effort（pwsh/ops_bash 写入、解构别名调用识别不了→该轮提取照跑，无数据损失），两个方向的局限都写在代码注释里。
- **面板删除条目改为移入回收站**：面板手动「删除条目」（`DELETE /entry`）不再硬删，与自动提取删除同口径——先进回收站（默认保留 30 天，可找回），不再是"删除即不可撤销"。
- **设置页新增「保留策略」**：回收站保留天数 / 快照保留份数 / 近期动态保留天数三个输入直接可调（存 `settings.json`，下一轮对话生效），不再要求手工改文件。
- **语义召回明确受三层开关管辖**：关掉「对话记忆」总开关 = 零注入、零外联，语义召回随之停跑（文档与界面口径统一）。
- **设置损坏可见与恢复**：`settings.json` 等解析失败时按缺省运行并挂 `corrupt` 标记、界面红条提示，重新保存对应内容即重写修复（放行前不静默吞错）。
- **放弃区间留痕**：结构性失败（无路由 / 无 cwd）被显式放弃的区间在盘上留痕，面板给出「已放弃 N 段」提示，不再悄悄消失。
- **面板体验修复若干**：健康卡与设置页交互打磨（提取记录折叠、未恢复区间双源提示、保留策略控件等）。
- **文档订正**：README 中英双版订正"保存条目无留档"的反向描述（保存条目有快照留档、删除进回收站可找回；人设/称呼保存无留档）、补 v0.4.1 新功能与观测字段、补数据布局顶层文件、测试数改为免漂移表述；ROADMAP 补 v0.4.1 行。
- `extractSession` 结算契约由 `"ok"|"error"` 字符串改为 `{status, detail}` 明细对象（内部 API；14 个返回点全带 outcome/reason）。
- `package.json` 重新加回 `private: true`，防止误发布到 npm（本插件只经 GitHub tag tarball 分发，不发 npm；此条订正此前"去掉 private"的记录，两者以本版为准）。

### 修复
- **设置损坏改为"留档 + 恢复"而非丢弃重写**：`settings.json` 解析失败时先改名保留原档（`settings.json.corrupt-<ts>`）、落 `settings.corrupt` 标记持久暴露红条，再从每次成功写入同步刷新的影子档 `settings.last-good.json` 恢复用户原开关，恢复不了才落默认。
- **删除条目的失败不再被含糊掩盖**：面板手动「删除条目」对"条目存在但读不出"的情况回显式错误状态（带中文原因），正常响应仍带 `ok`/`existed`/`trashed`/`trashId`，面板按 `existed` 如实提示（不存在时明确说"可能已被删除"，不无条件报"已移入回收站"）。
- **放弃区间的留痕跨重启持久**：结构性失败被显式放弃的区间（`abandoned`）落 `extraction-journal.jsonl` 并在面板持久可见，重启后仍能回答"哪些区间不再自动补"，不随任意一轮成功而消失。
- **面板/文案小修**：坏时间戳不再渲染「null 天后过期」、删除确认不再写死「默认保留 30 天」（改指设置页保留策略）、提取运行日志 outcome 枚举补 `abandoned`（文档与面板标签对齐五态）、`abandoned` 面板标签不再吐英文 token。

### 已知取舍
- "未恢复区间"对应的会话若已释放（未重开），手动重试够不着（补提只对在场会话生效）——面板文案已如实标注"需重开该会话"，不做空承诺。
- 总开关关闭期间每轮都会记一条 `skipped/gate-off`，会占用"最近提取记录"的名额（取舍：审计完整优先）。

## [0.4.0] - 2026-10-14

### 新增
- **写入可逆性：批前快照 + 回收站（项目侧）**：破坏性写入（覆写 / 删除）前自动留档旧文——覆写进 `backups/surgical/<batchId>/`，删除进 `trash/<entryId>/`（延迟删除，不再硬删）。面板新增「快照」与「回收站」两页：可按条 / 按单个文件恢复，回收站支持清除单条、按保留天数清理与全清。
- **覆盖前自动快照（全局侧）**：改写全局记忆既有条目前，先把旧文留档到 `backups/surgical/`；快照失败则跳过这次覆盖、原文保持不动——宁可漏一次更新，不可丢旧文。**面板手动改条目（`PUT /entry`）同样先留档**：保存全程持有提取批锁（与自动提取互斥，被占时 409），留档失败或留档为空直接拒绝保存（503、旧文一字未动），成功响应带 `preSaveSnapshotId`，可从「快照」页找回被顶掉的旧文。
- **恢复前留档**：从快照 / 回收站 / 整份备份恢复前，先对恢复目标处已存在的冲突文件留快照。整份备份恢复（`restoreBackup`）走「旧档改名 retired-* → 换入」流程，换入失败会自动把旧档改名回原位（**自动回滚**）；而快照 / 回收站恢复（`restoreSurgicalSnapshot` / `restoreTrash`）**不自动回滚**——按条循环写文件，中途失败就地停下，但恢复前的留底快照仍在盘上，API 失败响应带 `preRestoreSnapshotId` 与提示，供**手工**找回被覆盖的旧版。
- **恢复端点加锁**：三类恢复端点（快照 / 回收站 / 整份备份）与提取落盘共用 `<storageRoot>/extract.lock` 批锁，持锁失败即拒绝，杜绝"边恢复边写入"互相踩坏数据。
- **写后校验**：落盘后回读校验 frontmatter 四字段（`name` / `description` / `metadata.type` / `node_type`）可解析、`name` 与文件名一致、正文非空且未超长；校验失败则**回滚旧文**，新档移入快照 `failed/` 留标本（纯新增无旧文可回滚时进回收站），并计 `verifyFailed`。
- **硬事实丢失告警**：覆写导致既有硬事实（数字、版本号、十六进制标识、字节尺寸）从新文里消失时留痕告警并计 `hardfactDrops`；`hardfactPolicy: "block"` 时按校验失败回滚（默认 `"warn"`：只告警不阻断）。判据局限如实说明：同类型硬事实在新文里一个都不剩、或被极近的值顶掉（疑似誊写错误，如 269 记成 267）才检出——**正文里同类数字很多时，整行删除也可能检不出**；frontmatter、索引行与日期 / 倒计时等动态注记不参与比对，warn / block 的策略语义不变。
- **`sha1` 覆盖闸**：覆写 op 可带 `sha1`（覆盖既有文件必须带的短 sha1），与当前文件不符即拒绝该 op 并计计数器 `expectedSha1Mismatches`——防止基于过期内容误覆写。
- **盲写降级为追加**：无法安全覆写时保留旧正文，新内容以分隔线追加（不再整段覆盖），计 `blindWriteDowngrades`。
- **提取批锁**：提取落盘抢批锁（`<storageRoot>/extract.lock`，原子创建 + stale 超时接管），锁被占时破坏性 op 全部阻断并计 `lockConflicts`（纯新增 op 不受影响）。
- **安全面三项设置**：`surgicalKeep`（快照保留份数，默认 30）、`trashKeepDays`（回收站保留天数，默认 30）、`hardfactPolicy`（`warn` / `block`，默认 `warn`）；缺键走默认，旧 `settings.json` 无需迁移。
- **安全面可观测**：`/state` 新增 `safety` 字段共十个——盘上三项（`surgicalBackups` / `lastSnapshotAt` / `trashPending`，每次请求实时现算）+ 进程内七项计数（`verifyFailed` / `hardfactDrops` / `hardfactBlocks` / `expectedSha1Mismatches` / `blindWriteDowngrades` / `lockConflicts` / `snapshotFailures`，**重启清零**）；面板「管道健康卡」增一行安全面摘要。
- **备份补 project**：批量备份纳入项目记忆（此前只备份 `global/` + `settings.json`）。

### 变更
- **回收站先落副本后删原件**：删除记忆文件先把原文落副本进 `trash/<entryId>/`、确认副本与条目清单落稳后再删原件；副本落不稳即按未删处理、原文保留——不再出现"原件没了、回收站是空的"。
- **硬事实比对收窄误报**：比对前剥掉 frontmatter；索引行与日期 / 倒计时注记（含英文「N days left / ago」形态）整行剔除——只为"数字、版本号、十六进制标识、字节尺寸被静默改掉"报警，例行的时间滚动注记不再误报。
- `FORMAT.md` 新增第七节，声明 `backups/`（含 `backups/surgical/`）与 `trash/` 是**包外非真源目录**、可安全删除；`MEMORY.md` 与 `*.md` 才是记忆真源。
- README 中英双版补「写入可逆性」一节；`ROADMAP.md` 把已实现项从「未来方向」移出。
- **hardfact 拦截计数与写后校验失败分离**：`hardfactPolicy: "block"` 触发的回滚改计 `hardfactBlocks`，不再混入 `verifyFailed`（两种性质不同的失败分开观测；`/state.safety` 由九字段增至十字段）。
- **`backups/list` 响应移除常量字段 `kind`**：该列表只含全量备份，`kind` 恒为 `"full"` 且无任何消费方——按「删除优于兼容」移除（API 使用方注意：如依赖此字段请改用列表语义本身）。

### 修复
- **恢复备份失败不再连坐旧数据**：整份备份恢复在换入失败时先把旧档从 retired 目录改名回原位；若回滚也未成，保留 retired 目录不删（旧记忆可手工拷回）——不再"恢复失败连旧数据一起清掉"。
- **回收站清理参数校验**：`POST /trash/purge` 收到非法 `olderThanDays`（负数 / 非有限数）或非法 `id` 时显式返回 400，不再静默落入"全清"分支误删全部回收站条目。
- **settings 分字段保真合并**：`PUT /settings` 未提供的字段保持原值（安全面三项同此）。**嵌入密钥三态语义**：保存嵌入配置时 `apiKey` 键缺省 = 保留**生效**密钥（settings 已存的优先；密钥来自 entry config 而面板尚无覆盖时，把 config 密钥接管进 settings，不落空串遮蔽 YAML 里的密钥）；`null` / 空串 = 显式清空；非空串 = 新值。面板嵌入卡新增「清除已存 Key」按钮（只清面板保存的那份、只在其存在时出现；载荷仅 `apiKey:null`，不被其余字段的校验连带拒绝）。

## [0.3.1] - 2026-10-13

### 变更
- **全局记忆索引保最新**：每类行数上限由 40 下调为 22，并按「保留最新」裁剪——此前每类预算之和会撑破 120 行总闸，把靠后的分类整类裁掉；现在五类都能在注入里出现，且写满预算后新记忆不会从注入里消失。
- **新增 `recallTotalBudgetMs`（默认 20000ms）**：单轮语义召回的**整体时间预算**，约束分批串行嵌入的整轮耗时；超出后本轮按已缓存部分召回、下次续跑，不再让一轮卡满多次单请求超时。
- **`injectMaxChars` 现在是注入总预算**：召回块计入其中，主块为召回块让位——两段合计不再超出该预算。
- **无 webserver 的 profile 也能用记忆**：`webServer` 不再是硬依赖，插件在无 webserver 的 profile（如 headless）同样能加载并做记忆注入，只是不挂载 API 与面板。

### 修复
- **嵌入「测试连接」不再转发已存密钥**：已保存的 API Key 只发往它自己配置的端点；请求指向别的地址时不再把旧密钥带过去。
- **召回块去重**：改为比对会话视野内**全部**召回块，避免命中集每轮变化时逐轮新增、无限累积；相同内容不再重复注入。
- **索引文件名与磁盘一致**：`MEMORY.md` 里的链接目标统一小写 + `.md`，与磁盘文件名逐字节一致，在大小写敏感文件系统上不再断链。
- **非法文件名显式拒绝**：保留名、`../`、黑名单段等非法名不再被静默改名或拍扁，而是明确拒绝（跳过并告警）；标题净化为空时的兜底文件名也改为确定性命名（同标题同名，重复导入不再每次生成新名）。
- **存储格式标记损坏先备份**：`keepsake-format.json` 损坏（截断 / 非法 JSON）时，先改名备份（`*.corrupt-<时间戳>`）再补写当前版本，绝不静默覆盖销毁可能记录的降级信号。
- **`null` 请求体返回明确的 400**：请求体为合法 JSON `null` 时按空体处理，缺必填字段走 400，不再误报 500。

## [0.3.0] - 2026-10-13

### 新增
- **分发与升级**：README 补齐 GitHub tag tarball 渠道的安装与升级步骤（DSH 插件不支持自动更新，升级 = 重装新版；数据在插件包目录之外，卸载重装不受影响）。
- **DSH peer 兼容声明**：`package.json` 声明 `@deepseek-ai/dsh-client-ui-slots@^0.2.0-rc.2`，宿主在安装/启动时据此做版本兼容检查（不匹配需用户显式豁免）。
- **存储格式版本闸**（防降级误改数据）：存储根新增 `keepsake-format.json` 记录格式版本；数据被更新版插件写入时（标记高于当前）本版本自动转只读——拒绝写端点（503）、跳过滚动清理与提取落盘，读取仍放行；标记缺失/损坏自动补写当前版本。`/state.format` 暴露状态，门牌与设置页「管道健康卡」显示只读告警。

### 变更
- README 中英双版新增「升级」一节与「分发」摘要；`FORMAT.md` 新增第七节「存储格式版本」；`ROADMAP.md` 新增「分发与升级」。

## [0.2.0] - 2026-10-13

### 新增
- **注入通道迁移**：四段记忆注入从系统提示词（section）迁到 **durable 用户消息通道**，对所有预设生效（根治极简预设 `complete:true` 下的静默失忆）；`injectChannel: "section"` 可一键回退。
- **语义召回（可选，默认关）**：按当前用户消息做嵌入余弦 top-k 检索，命中条目以 `<memory-recall>` 块注入；provider-agnostic，端点由配置注入，不配置则不产生任何外部调用。
- **提取韧性链**：可取消退避重试（含 `Retry-After` 优先）、失败分类、失败落盘日志（`extraction-errors.log`）、以及换道兜底 `fallback`。
- **记忆管理面板**：门牌 + 四个对话分类页 + 长期记忆页 + 人设页（五套预设模板）+ 称呼页 + 项目记忆概览 + 设置页（三层开关、管道健康卡、数据卡）。
- **自动备份与恢复**：批量破坏性操作前自动全量备份，滚动保留最新 20 份；半备份标记「不完整」且拒绝恢复。
- **手动补提**：面板「立即重试提取」按钮（真发一次 LLM 提取，带节流与在途 409）。
- **观测面**：`/state` 暴露 `extractionFailures` / `injection` / `recall` / `lastUsedRoute` 等字段；面板「管道健康卡」承载。
- **记忆文件格式约定**：[FORMAT.md](FORMAT.md)（frontmatter / 索引行 / `[[name]]` 互链 / 跨 agent 互认）。
- **公开合规**：新增 MIT [LICENSE](LICENSE)、`.gitignore`，补齐包元数据（repository / homepage / bugs / author / engines）。

### 变更
- `package.json` 去掉 `private` 标记，`files` 纳入 `FORMAT.md`。
- README / ROADMAP 产品化改写（对外路线图）。

### 修复
- 提取结果畸形操作跳单容错、单条 IO 失败隔离、结构性失败（无路由 / 无 cwd）连续 5 次后显式放弃。
- 召回向量缓存写盘失败由静默降级改为显式 `warn`。
- 注入/召回失败与渲染失败显式计入观测面（不静默丢）。
- API 请求体超限现在稳定返回显式 413（此前 socket 被提前销毁，客户端只见连接被重置）。
- 新增条目：标题含 `/` 时自动取末段命名，不再误报「name 非法」。
- 删除条目时目标文件被外部占用（Windows EBUSY/EPERM）不再抛 500。
- 面板响应加同源嵌入防护头（`X-Frame-Options` / CSP `frame-ancestors`），防第三方页面内嵌做点击劫持。
- 文档：英文 README 的已知限制补齐至与中文对齐；订正测试数量。注释清理（去掉与实现无关的编号标记）。

## [0.1.0] - 2026-10-01

### 新增
- 初版：项目记忆自动提取 + 注入 cordis 插件（事件订阅、进程内单飞状态机、三道闸文件名净化、注入预算裁剪、`~/.dsh/memory/` 本地 markdown 落盘）。

### 修复
- `enabled` 缺省关（fail-closed）；索引缓存键加项目维度；Windows 保留设备名段防穿越；截断保最新；直写判定按结果成败校验；CJK 词数折算；关停 drain 纪律；debug 日志口。

[未发布]: https://github.com/axuan-1314/dsh-keepsake/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/axuan-1314/dsh-keepsake/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/axuan-1314/dsh-keepsake/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/axuan-1314/dsh-keepsake/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.4.1
[0.4.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.4.0
[0.3.1]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.3.1
[0.3.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.3.0
[0.2.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.2.0
[0.1.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.1.0
