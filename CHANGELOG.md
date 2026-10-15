# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，变更记录格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

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
- 文档：英文 README 的已知限制补齐至与中文对齐；订正测试数量。注释清理（去内部批次/审查编号）。

## [0.1.0] - 2026-10-01

### 新增
- 初版：项目记忆自动提取 + 注入 cordis 插件（事件订阅、进程内单飞状态机、三道闸文件名净化、注入预算裁剪、`~/.dsh/memory/` 本地 markdown 落盘）。

### 修复
- `enabled` 缺省关（fail-closed）；索引缓存键加项目维度；Windows 保留设备名段防穿越；截断保最新；直写判定按结果成败校验；CJK 词数折算；关停 drain 纪律；debug 日志口。

[未发布]: https://github.com/axuan-1314/dsh-keepsake/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.4.0
[0.3.1]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.3.1
[0.3.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.3.0
[0.2.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.2.0
[0.1.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.1.0
