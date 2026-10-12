# dsh-memory 迭代路线（ROADMAP）

> 日期：2026-10-13（**rev.2**，同日首版后的优化版；rev.1 → rev.2 的改动清单见 §0）。
> 一句话：下一版（建议 v0.2.0）根治注入通道 P0——四段注入迁往 durable user 消息通道，**默认主载体、全 preset 生效**；前置注入链防御性自查，顺带工程卫生与观测收口。

## 0. 本版（rev.2）相对首版改了什么

| 类别 | 首版（rev.1） | rev.2 订正 | 依据 |
|---|---|---|---|
| **事实** | 「main ahead 1（732c3a6 未推送）；README.md 工作区有未提交改动」 | **已过期**：`origin/main` 与本地齐平（均 `3e71123`），工作树干净、0/0 ahead-behind；239 测试今日复跑全部通过。M5/风险 7 相应改写 | 今日 `git fetch` + `git status` + `npm test` 实跑 |
| **机制** | 双保险「检测到 complete 场景时消息通道兜底」 | **不可实现且无必要**：插件探测不到他人 section 的 `complete` 标志（`dsh-system-prompt` 的 section 参数无 condition 字段，见《调研笔记》§4.4），而消息通道在**所有** preset 下都生效 → 改为「消息通道常开为主 + section 降为一条静态路由指引」，**不做运行时探测** | 《调研笔记》§4.4；mnemon 三保险同构（§1.2） |
| **证据** | 通道可行性引自三家竞品 | 升级为**本机 rc.2 官方包实证**：`dsh-agent` 的 `inject()`/`agent/pre-step`/入步消息契约（README:47/85/144）+ 官方 `dsh-agent-instructions` 标准范式（`createUserMessage`+`source.kind`+`sessionProjections`+digest 去重）——比竞品引用更硬的同宿主证据 | 本机 `resources/app/dsh/node_modules/@deepseek-ai/` 实读 |
| **新增** | — | M2 前置落点确认（30 分钟级）、消息通道**注入总预算 + supersede 纪律**（首版只给批 B1 召回块定了预算，漏了主注入）、`/state` 观测字段规格、新 config 键**进严格校验**、任务依赖图 | 本版自查 + 工作机制 |
| **待确认** | 新通道「config 默认关、cordis 显式开」 | **修正为默认开**：默认关 = 默认用户（含 minimal 用户）仍失忆，与「根治 P0」自相矛盾；改推荐默认 message 为主，回滚 = 切回 section | 逻辑自洽性 |

## 现状速览

- 版本字段 0.1.0，但 git log 在 v0.1.0（`62c14cb`）后已 **11 个提交**（10 个施工/修复批 + 本次文档批 `3e71123`）；`origin/main` 已与之齐平，工作树干净。239 测试今日（2026-10-13）复跑全部通过。零 npm 依赖、纯 markdown 本地记忆。
- 已具备：四段 systemPrompt 注入、面板/门牌/管道健康卡/备份恢复、429 韧性链（重试/失败分类/失败日志/手动补提）。
- 已知缺口（均有代码证据）：
  - 宿主 minimal 预设 `complete:true` 会把 systemPrompt 组装结果整体替换，四段静默消失无报错（调研定级 P0，现存未修）；
  - 本仓注入链自身存在 try/catch 静默降级路径（见 M1）；
  - fallback 换道仅校验+持有未接线（`lib/index.js:586-589` 注释自认"本批只校验持有、不换道"）；
  - U7 嵌入召回仅面板占位（`lib/api.js:299` 注释"U7：语义召回预留位"）。
- 外部调研已交付（2026-10-10，对抗审查 有条件通过）：推荐方向 A=本地 markdown 深耕，批 A-D 骨架与审查四前置已备，批 A 标注"可立即开工"。文档路径：
  - `docs\direction-plan.md`（下称《方向方案》）
  - `docs\plugin-survey-notes.md`（下称《调研笔记》）
- 工程遗留：`npm run check` 为 bash for-loop，Windows cmd 跑不通（package.json scripts.check）；README.md「防自反馈」不变量（:69、:262）将被批 A 推翻，待 M4 同步。

## 下一版主目标与版本号

**主目标：批 A 全量落地（P0 注入通道迁移，默认主载体）+ 注入链防御性自查 + 工程卫生。**

**建议版本号：v0.2.0（minor）。**

理由：

1. 批 A 推翻 README 已文档化的行为不变量「提取调用不向任何 session append 事件」（README.md:69、:262；注入迁往 user 消息通道后失效）——行为契约变化；
2. 引入新 config 键（`injectChannel` 等）与用户可感知的对话流变化（消息通道内容在会话流可见）；
3. 以上超出 patch（0.1.1）量级；但范围收敛为调研单批（A），不动存储格式、不含批 B/C，够不着更大版本。

批 B（检索召回）顺延为 v0.3.0 主菜；批 C 待 M7 闸门；批 D 治理项随批顺带。版本节奏一览：

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1.x（已发） | 现状：四段 section 注入 + 面板 + 429 韧性链 | 239 测试绿 |
| v0.2.0（本版） | M0-M5（批 A + 落点确认 + 自查 + 工程卫生），M6 候选 | 本 ROADMAP |
| v0.3.0 | 批 B：嵌入召回（B1）+ 注入措辞/回声抑制（B3/B4），M6 若未随上版则首位 | 待嵌入选型（确认 #5） |
| v0.4.x | 批 C：git 摄取/知识页/斜杠命令/turn 可见性 | 待 M7 闸门 |
| 随批 | 批 D：三道闸/写后读/byte 预算/snapshotEvents 迁移/FORMAT.md | 治理项随批顺带 |

## 任务依赖图

```
M1 静默降级自查 ─┐
                 ├─→ M2 通道迁移 ─→ M3 防自食去重 ─→ M4 检查&文档 ─┬─→ M5 工程卫生收尾
M0 落点确认 ─────┘（M2 前置·30min）                              └─→ M6 fallback（若确认随版）

M7 官方插件对照（挂日历，不阻塞任何任务）
```

- M0 是 M2 的唯一硬前置（30 分钟级探针，不写产品代码）。
- M1 与 M2 **同批开工**，M1 先出结论（已初查实锤两处，见任务单）。
- M2/M3/M4 一体闭环：拆开即回滚风险（M2 落地不得缺 M3）。
- M5 收尾；M6 若确认随版则插在 M4 后、M5 前。

## 任务单

### M0（新）注入通道落点确认（探针，不写产品码）

- **【做什么】**
  在 rc.2 现网 30 分钟内跑通一次最小验证，钉死 M2 将采用的确切 API 与语义，避免批 A 在建制期返工。逐条验证：
  ① **载体 API**：`dsh-agent` 暴露 `followup/steer/inject` 三件套（README:47），`inject()`「adds model-facing context **without waking the driver**, so it lands in the next admitted step」；`agent/pre-step` 可 `{kind:'enter', messages, startsRequestSeries?}` 替换入步消息（README:85）。确认插件侧拿到 agent 句柄的路径（`ctx.on("agent/*")` 事件源 vs 需要显式 agent 引用）。
  ② **消息形状**：用 `@deepseek-ai/dsh-llm` 的 `createUserMessage({..., source:{kind:"plugin:dsh-memory", form:"inject", ...}})` 构造（官方 `dsh-agent-instructions` 范式，其 `lib/index.js:767-790`；import 见 :2）。
  ③ **durable 与可见**：注入消息落成 `user/message` 事件、进模型可见 surface、跨轮驻留、resume 回放、参与 compaction（《调研笔记》§4.4 结论的现网复验）。
  ④ **可归因**：我们自己的 `session/event` 订阅读到该事件时 `event.data.source.kind` 可辨（M3 过滤全靠它）。
  ⑤ **视野与去重**：能否从会话 surface/`sessionProjections` 判断自家块是否仍在视野（mnemon `cueAlreadyVisible` 等价物）。
  产出：一页探针结论（落调研目录），明确 M2 采用的 API 名与调用形态；给 fakeCtx 设计（测试如何模拟 `agent/pre-step`）。
- **【依据】** 本机 rc.2 `@deepseek-ai/dsh-agent`、`dsh-agent-instructions`、`dsh-llm` 实读；《调研笔记》§4.4/§4.5；《方向方案》A1 载体。
- **【验收】** 探针脚本 headless 跑通，日志备份；M2 施工据此不猜 API。
- **【优先级】** P1（M2 硬前置，量小、先做）。
- **【来源】** rev.2 新增（首版直接进施工，缺此前置）。

### M1 注入链静默降级防御性自查 + 测试钉

- **【做什么】**
  全量盘点四段注入链的"静默降级"路径并钉测试。已初查实锤两处：
  ① 宿主侧——任何 persona 段声明 `complete:true` 时 systemPrompt 组装结果被整体替换为该段，其他 section 静默消失无报错（minimal 出厂预设即开启；锚点《调研笔记》§4.4 `dsh-system-prompt/lib/index.js:335-367`），本仓对这一场景零检测零提示；
  ② 本仓侧——四段 `text` 函数均 `try/catch → return ""`（`lib/index.js:854-927`），渲染失败仅 `log.error`，叠加宿主"空段自动丢弃"后等于该段记忆静默消失，面板与健康卡均不可见。
  自查范围再扫：全局索引读取失败、索引缓存失效、settings 解析失败（后者已有 corrupt 红条，确认不漏）。
  产出：自查结论（补进 README 已知限制或 docs）+ 回归测试钉（渲染失败必须留下可断言痕迹）。
  **与首版的差别**：②的根治不必靠"检测 complete"——M2 换通道后 ① 天然消失（消息通道全 preset 生效），M1 的价值收敛为"把本仓自身的静默降级路径显式化"。
- **【依据】** 任务背景点名"竞品 P0 同类路径自查"；《方向方案》R2 与审查 P3-2；仓内 `lib/index.js:854-927`、README.md 工作原理节。
- **【验收】** 每条静默路径要么有测试钉死行为、要么修复为显式可见（失败痕迹进健康卡/metrics 口径）；自查结论落文档。
- **【优先级】** P0（与 M2 同批开工，M1 先行出结论）。
- **【来源】** 调研方案（R2）+ 仓内自查新发现（代码证据如上）。

### M2 批 A1+A3：注入通道迁移至 durable user 消息 + 双保险

- **【做什么】**
  四段内容改走 durable user 消息通道（M0 定形），producer-owned `source:{kind:"plugin:dsh-memory", form:"...", digest:"..."}`。
  **默认主载体、不做运行时探测**（rev.2 机制修正）：消息通道在所有 preset 生效，section 仅作兜底——
  - `injectChannel` 两值开关：`"message"`（默认）| `"section"`（旧路径，一键回滚）；
  - `"message"` 模式下 section 侧**保留一条静态路由指引**（order 沿用既有段位，内容退化为"记忆在消息通道，按需 Read <memoryDir>"一行），standard 下多一层兜底、minimal 下被 complete 吃掉也无所谓（消息通道已覆盖）；
  - 启动注入一次化（人设/索引首轮发，不逐轮重复），逐轮仅当索引变化时补发。
  **视野确认**：同文本跳过之外，扫会话 surface 确认提醒仍在视野内（compaction/rewind 会把启动注入挤出视野），丢了才补发（对齐 mnemon `cueAlreadyVisible`）——否则长会话 compaction 后记忆静默消失，等于换通道复发老毛病。
  **注入总预算 + supersede 纪律（rev.2 新增）**：消息块是逐轮驻留 surface 的 durable 消息，长会话 token 随补发次数累积——
  - 新 `injectMaxChars` 预算封顶单次注入（人设 16k / 全局 12k / 项目 25k 之和已近 53k 字符，需显式封顶而非默认全量）；
  - **同 `form` 同文本跳过**、变化才补发；不做历史消息删除（已提交历史不可改），旧块靠同文本跳过不再增长 + compaction 兜底；
  - metrics 记账累计注入字符/补发次数（可观测，见 M4）。
  新通道挂 config 开关（`injectChannel`），**默认 `"message"`**（见待确认 #6 修正）。
- **【依据】** 《方向方案》批 A1/A3；《调研笔记》§4.4、§6#1——三家竞品与官方 agent-instructions 全走此通道；rc.2 官方包实证见 M0 依据。
- **【验收】** minimal 预设下四段内容出现在模型可见消息流；standard 下行为不劣化；compaction 后视野确认能补发；注入总量受 `injectMaxChars` 约束；`injectChannel:"section"` 一键回滚到现状。
- **【优先级】** P0（本版主菜）。
- **【来源】** 调研方案（批 A1/A3 + 审查 P1-1 视野确认）+ rev.2 机制修正/预算纪律。

### M3 批 A2：防自食与去重（含 subagent 决策落点）

- **【做什么】**
  通道迁移后注入消息会以 user 身份进入事件流，两处统一过滤——**在 `messageOf`/`textBlocksOf` 层按 `source.kind`（`"plugin"` / `"plugin:"` 前缀）排除**（`lib/transcript.js:17-33` 已是公共取数层，统一改这里，不逐处打补丁）：
  `hasEnoughUserProse`（:39-48）——不过滤则注入长文必过 ≥3 词门槛，skip 门槛被架空，纯注入轮白烧提取调用；
  `renderTranscript`（:99-127，提取输入渲染）——不过滤则注入内容以"用户发言"身份进提取 prompt 被记回记忆。
  resume/启动去重走 `session/event` 订阅 + `sessionProjections` 记账（rc.2 已有；**不用** alpha 已 deprecated 的 `ownEvents()`，避免二次迁移）——官方 `dsh-agent-instructions` 即 `inject=["sessionProjections"]`（`lib/index.js:1073`）。
  subagent 会话显式决策（调研倾向：排除注入、提取维持现状观察）；若排除注入，提取侧同口径排除（避免"没注入却仍提取 subagent"的不一致）。
  补「纯注入批次必须 skip 提取」断言。
- **【依据】** 《方向方案》批 A2 与审查记录"自家适配盲区"（审查员代码级实证两处过滤落点）；《调研笔记》§2.1/§3.1（hindsight/openviking 同款过滤与 subagent 跳过）。
- **【验收】** 注入内容不进提取输入；纯注入轮不触发 LLM 提取调用（测试断言）；resume 不重复注入。
- **【优先级】** P0（与 M2 配对，M2 落地不得缺 M3）。
- **【来源】** 调研方案（批 A2 + 审查 P1-2/P2-1）。

### M4 批 A4：检查与文档同步

- **【做什么】**
  新增注入面测试：minimal preset 场景模拟（fakeCtx 捕获消息通道注入）、双通道开关矩阵（`injectChannel` 两值 × 三层开关）、纯注入批次必 skip 断言、resume 不重复注入、supersede/同文本跳过、`injectMaxChars` 预算裁剪。
  **新 config 键进严格校验（rev.2 新增）**：`injectChannel`/`injectMaxChars` 必须注册进配置校验表（未知键即抛 + did-you-mean），并补未知键测试——否则新键在 `cordis.patch.yml` 一出现就被自己的严格校验拒掉，插件起不来。
  **观测面同步**：`/state` 增注入面字段（如 `injectChannelActive` / `injectedChars` / `injectResends` / `injectChannelErrors`），健康卡/门牌按批F2 模式承载（服务端恒在，缺失=旧版）。
  现有 239 测试全部通过不回退；`test/inject-sections.test.mjs` 与 `test/client-source.test.mjs`（防漂移检查）测试面同步。
  README 同步：「不向任何 session append 事件」不变量表述推翻重写（README.md:69、:262 两处），配置表新增键、工作原理节、回滚节、已知限制联动更新；版本号回写。
- **【依据】** 《方向方案》批 A4 与审查 P2-5；rev.2 配置键/观测面纪律。
- **【验收】** 全部检查绿；README 无失效表述；版本字段与发布内容一致；新 config 键在新装 profile 上能起。
- **【优先级】** P0（收尾件，随 M2/M3 同批完成）。
- **【来源】** 调研方案（批 A4 + 审查 P2-5）+ rev.2 补充。

### M5 工程卫生：check 脚本跨平台 + 版本纪律

- **【做什么】**
  ① `npm run check` 由 bash for-loop（`for f in lib/*.js; do node --check "$f" || exit 1; done`，见 package.json scripts）改为 `node -e` 单行实现，Windows cmd 原生可跑，零新增依赖；
  ② 版本纪律：本版提交时 package.json 回写 0.2.0，并确立"每施工批提交同步 bump 版本"的规矩（本次 0.1.0 挂 11 批即失守的实证）。
  （**推送遗留已消除**：rev.1 记录的 `732c3a6` 未推与 README 未提交改动，经今日核查 `origin/main` 已齐平、工作树干净——本项无需再收口。）
- **【依据】** package.json scripts.check 现状（bash 语法，cmd 下直接报错）；version 0.1.0 vs git log 11 提交。
- **【验收】** cmd 与 bash 双跑 `npm run check` 均通过；版本字段与本 ROADMAP 一致。
- **【优先级】** P1。
- **【来源】** 新发现（审查）+ 仓内遗留。

### M6 批 B2（候选）：fallback 换道接线

- **【做什么】**
  把 inert 的 `fallback` 配置接进提取调用链：主道 attempt 链不可恢复失败后，逐条 fallback 路由以同一 attempt 链调用，成功记 `fallbackUsed` 并落盘。
  接线点已在代码注释中标注（`lib/index.js:586-589`）；metrics 字段与面板分桶位已备（`lib/metrics.js:27/117`，`lib/panel-logic.js:256` `EXTRACTION_BUCKET_KEYS` 已含 fallbackUsed）——纯接线，无新面。
- **【依据】** 《方向方案》批 B2 与 R6（免费池 429 重演对策）；README 配置表明示"当前仅校验+持有（inert）"。
- **【验收】** 主道耗尽换道成功后 `/state` 可见 fallbackUsed>0 且 lastUsedRoute 记账；未配置 fallback 时行为与现状完全一致。
- **【优先级】** P1（是否随本版见待确认 #2，不阻塞批 A）。
- **【来源】** 仓内遗留（inert 项）+ 调研方案（B2）。

### M7 R1：官方记忆插件对照评估（调研件，不写码）

- **【做什么】** 官方记忆插件预告"10 月中旬"发布（今日 10-13，窗口已开）。发布后一周内做一次功能面对照评估：确认其是否覆盖 git 摄取/知识页，据此收敛或调整批 C 范围。
- **【依据】** 《方向方案》批 C 前置闸门（审查 P2-4）与 R1 风险条。
- **【验收】** 一页对照结论（落调研目录），批 C 开工与否据此确认。
- **【优先级】** P3（不阻塞本版任何任务）。
- **【来源】** 调研方案（R1 闸门）。

## 明确不做什么（本版）

- **不做运行时 `complete` 探测**：插件探测不到他人 section 的 complete 标志，且消息通道全 preset 生效——探测既不可行也无必要（rev.2 机制修正）。
- **不做 provider 化 / 云后端接入**：方向 C，《方向方案》§3 判 ❌——放弃零依赖卖点，生态位已被 mnemon 占。
- **不依赖 `appendPluginRecord`**：alpha 实验契约只许官方包调用（《调研笔记》§4.1）——观望，等转正或官方记忆插件落地后重评。
- **不做批 C 内容**（git 摄取/知识页/斜杠命令/turn 可见性）：R1 对照闸门未过，工作量最大，留待 v0.4.x。
- **不做批 B1 嵌入召回**：嵌入服务选型未确认（待确认 #5），v0.3.0 主菜。
- **不做单条覆盖写编辑历史与 4995 全量读优化**：README 已知限制中两项"有意不修"，本版维持原判。
- **不动存储格式与数据布局**：保证本版零数据迁移风险，同时为方向 B（官方插件增强层，观望档）留迁移余地。
- **不移植 taskType 全量过滤**：skip 双门槛兜底已覆盖（README 已知限制），subagent 取舍随 M3 决策后一并观察。

## 风险与回滚

| # | 风险 | 对策与回滚 |
|---|---|---|
| 1 | 消息通道注入污染用户对话流（UI 可见、用户困惑） | `source.kind` 标记 + 实机验证 UI 呈现（R8）；回滚 = `injectChannel` 切回 `"section"`，config 热载（web HMR / desktop 重启），不动数据 |
| 2 | compaction/rewind 把注入挤出视野，记忆静默消失（换通道复发老毛病） | M2 视野确认 + metrics 记账注入次数/字符（可观测）；测试钉 compaction 场景 |
| 3 | 通道迁移回归（现有 239 测试面部分被推翻重建） | M4 检查矩阵先行补齐再迁移；`inject-sections.test.mjs` 重写为双通道开关矩阵；全部通过才算完 |
| 4 | 提取自食（注入内容被记回记忆） | M3 两处过滤 + 纯注入批次必 skip 断言；审查员已实证过滤落点 |
| 5 | 免费池 429 重演（10-09 事故） | 退避链已有（732c3a6）；若 M6 随版则换道兜底，否则维持现状并在 v0.3.0 首位 |
| 6 | 官方插件入场挤压（时间窗已开） | M7 对照评估定批 C 去留；生态位（本地/markdown/可 git/观测面/跨 agent 复用）官方大概率不占 |
| 7 | 版本纪律失守重演 | M5 版本纪律；推送遗留已消除（rev.2 核查齐平），发布动作另行确认 |
| 8（新） | **rc.2 注入 API 行为与预期不符**（`inject` 不落 surface / 不可 resume / 拿不到 agent 句柄） | M0 落点确认先行；若 `inject()` 不通，退用 `agent/pre-step` 的 `{kind:'enter', messages}` 替换入步消息；两者都不通则批 A 重估（本版退回只做 M1+M5） |
| 9（新） | **消息通道累积烧 token**（长会话补发不断堆积） | M2 `injectMaxChars` 预算 + 同文本跳过 + metrics 记账累积量；旧块靠 compaction 收敛 |

每批三件套纪律照旧：检查全部通过 + 可观测（metrics/面板）+ 回滚开关（config 显式、默认旧路径仍可切）。

## 待确认项

1. **版本号**：推荐 v0.2.0（行为契约变化：README 不变量推翻 + 新 config 键 + 用户可感知变化）；备选 0.1.1（纯 patch 语义，不匹配本批体量）。
2. **M6 fallback 接线是否随 v0.2.0**：推荐随（纯接线、观测面已备、R6 直接对策、成本低）；若求单批聚焦可顺延 v0.3.0 首位，不阻塞。
3. **双保险组合**：推荐「消息通道为主（`injectChannel:"message"`）+ section 保留一条静态路由」（《方向方案》A3 倾向，mnemon 三保险同构，且不做运行时探测）；备选"完全删除 section"（更彻底，但 standard 下少一层兜底）。
4. **subagent 会话取舍**：推荐"排除注入、提取同口径排除"（《方向方案》A2 倾向，hindsight/openviking 均整体跳过；rev.2 把"提取维持现状"收紧为同口径，避免注入/提取不一致）。
5. **嵌入服务选型**（v0.3.0 前置，本版只挂账）：本地 ollama / 现有免费池 / 付费 API + 隐私边界（记忆文本出不出本机）——《方向方案》待确认 #2 原样移交。
6. **新通道默认状态（rev.2 修正）**：推荐 **默认 `"message"`**——默认关 = 默认用户（尤其 minimal 用户）仍失忆，"根治 P0"落空；回滚键齐备（切 `"section"`）。备选"默认 `"section"`、用户显式开"（更保守，但 P0 修复对默认用户不可见，与工作规矩"开关默认关"的表面一致性优先于修复实效——**不建议**）。

---

## 附：执行顺序与取证口径

- 建议执行顺序：**M0（30min 落点确认）→ M1 先出结论（与 M2 同批开工）→ M2+M3+M4 一体闭环（通道迁移、防自食、检查文档）→ M5 工程卫生收尾**；M6 若确认随版则插在 M4 后、M5 前；M7 挂日历（官方插件发布后一周内），不阻塞任何任务。
- 取证口径（2026-10-13 rev.2 审查）：
  - **代码锚点**：M1 四段 text 函数 `try/catch→return ""`（`lib/index.js:854-927`）、M6 fallback inert 注释（`lib/index.js:586-589`）、U7 预留位（`lib/api.js:299`）、README 不变量两处（:69、:262）、metrics/面板分桶位（`lib/metrics.js:27/117`、`lib/panel-logic.js:256`）、M3 过滤层（`lib/transcript.js:17-33` 公共取数层、:39-48 skip 门槛、:99-127 提取渲染、:55-86 直写判定）均开码对证。
  - **rc.2 通道证据（rev.2 新增，本机官方包实读）**：`@deepseek-ai/dsh-agent` README:47（`followup/steer/inject`，`inject` 不唤醒 driver）/ :85（`PreStepDecision {kind:'reject'|'enter', messages, startsRequestSeries?}`）/ :144（注入即 identified user-role 消息，进派生历史）；`@deepseek-ai/dsh-agent-instructions` `lib/index.js:2`（`import { createUserMessage } from "@deepseek-ai/dsh-llm"`）/ :767-790（`createUserMessage({..., source:{kind:...}})`）/ :1073（`inject=["sessionProjections"]`）。
  - **宿主语义**：`complete:true` 整体替换（《调研笔记》§4.4，`dsh-system-prompt/lib/index.js:335-367`），调研 sources 源码 `assemble()` 注释审查成立。
  - **检查**：239 测试 2026-10-13 实跑全部通过；`origin/main` 与本地齐平（`3e71123`）。
- 维护约定：任务完成即勾销并注明提交号；新增任务必须有仓内证据或调研文档出处，禁止凭空造功能。
