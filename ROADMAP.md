# dsh-memory 迭代路线（ROADMAP）

> 日期：2026-10-13。
> 一句话：下一版（建议 v0.2.0）根治注入通道 P0——四段注入迁往 durable 消息通道，前置注入链防御性自查，顺带工程卫生收口。

## 现状速览

- 版本字段 0.1.0，但 git log v0.1.0 后已 **10 个施工/修复批**（早期两修复批 → 对抗审查修复 → M0 → M1 → M2 → M3 预备/实机 → 三路审查 → 全面审查 → 429 韧性观测批，共 11 个提交）；239 测试今日实跑全部通过（审查当日复跑确认）；零 npm 依赖、纯 markdown 本地记忆。
- 已具备：四段 systemPrompt 注入、面板/门牌/管道健康卡/备份恢复、429 韧性链（重试/失败分类/失败日志/手动补提）。
- 已知缺口（均有代码证据）：
  - 宿主 minimal 预设 `complete:true` 会把 systemPrompt 组装结果整体替换，四段静默消失无报错（调研定级 P0，现存未修）；
  - 本仓注入链自身存在 try/catch 静默降级路径（见 M1）；
  - fallback 换道仅校验+持有未接线（lib/index.js:586-589 注释自认"本批只校验持有、不换道"）；
  - U7 嵌入召回仅面板占位（lib/api.js:297-299 注释"U7：语义召回预留位"）。
- 外部调研已交付（2026-10-10，对抗审查 有条件通过）：推荐方向 A=本地 markdown 深耕，批 A-D 骨架与审查四前置已备，批 A 标注"可立即开工"。文档路径：
  - `docs\direction-plan.md`（下称《方向方案》）
  - `docs\plugin-survey-notes.md`（下称《调研笔记》）
- 工程遗留：`npm run check` 为 bash for-loop，Windows cmd 跑不通；main ahead 1（732c3a6 未推送）；README.md 工作区有未提交改动。

## 下一版主目标与版本号

**主目标：批 A 全量落地（P0 注入通道迁移）+ 注入链防御性自查 + 工程卫生。**

**建议版本号：v0.2.0（minor）。**

理由：

1. 批 A 推翻 README 已文档化的行为不变量「提取调用不向任何 session append 事件」（README.md:262；注入迁往 user 消息通道后失效）——行为契约变化；
2. 引入新 config 键与用户可感知的对话流变化（消息通道内容在会话流可见）；
3. 以上超出 patch（0.1.1）量级；但范围收敛为调研单批（A），不动存储格式、不含批 B/C，够不着更大版本。

批 B（检索召回）顺延为 v0.3.0 主菜；批 C 待 M7 闸门；批 D 治理项随批顺带。版本节奏一览：

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1.x（已发） | 现状：四段 section 注入 + 面板 + 429 韧性链 | 239 测试绿 |
| v0.2.0（本版） | M1-M5（批 A + 自查 + 工程卫生），M6 候选 | 本 ROADMAP |
| v0.3.0 | 批 B：嵌入召回（B1）+ 注入措辞/回声抑制（B3/B4），M6 若未随上版则首位 | 待嵌入选型（确认 #5） |
| v0.4.x | 批 C：git 摄取/知识页/斜杠命令/turn 可见性 | 待 M7 闸门 |
| 随批 | 批 D：三道闸/写后读/byte 预算/snapshotEvents 迁移/FORMAT.md | 治理项随批顺带 |

## 任务单

### M1 注入链静默降级防御性自查 + 测试钉

- **【做什么】**
  全量盘点四段注入链的"静默降级"路径并钉测试。已初查实锤两处：
  ① 宿主侧——任何 persona 段声明 `complete:true` 时 systemPrompt 组装结果被整体替换为该段，其他 section 静默消失无报错（minimal 出厂预设即开启；锚点《调研笔记》§4.4 `dsh-system-prompt/lib/index.js:335-367`），本仓对这一场景零检测零提示；
  ② 本仓侧——四段 `text` 函数均 `try/catch → return ""`（lib/index.js:854-927），渲染失败仅 `log.error`，叠加宿主"空段自动丢弃"（README.md 工作原理节）后等于该段记忆静默消失，面板与健康卡均不可见。
  自查范围再扫：全局索引读取失败、索引缓存失效、settings 解析失败（后者已有 corrupt 红条，确认不漏）。
  产出：自查结论（补进 README 已知限制或 docs）+ 回归测试钉（渲染失败必须留下可断言痕迹）。
- **【依据】** 任务背景点名"竞品 P0 同类路径自查"；《方向方案》R2 与审查 P3-2；仓内 lib/index.js:854-927、README.md 工作原理节。
- **【验收】** 每条静默路径要么有测试钉死行为、要么修复为显式可见（失败痕迹进健康卡/metrics 口径）；自查结论落文档。
- **【优先级】** P0（与 M2 同批开工，M1 先行出结论）。
- **【来源】** 调研方案（R2）+ 仓内自查新发现（代码证据如上）。

### M2 批 A1+A3：注入通道迁移至 durable user 消息 + 双保险

- **【做什么】**
  四段内容改走 `agent/pre-step` 追加 durable user 消息，producer-owned `source:{kind:"plugin:dsh-memory"}`。
  启动注入一次化（人设/索引不逐轮重复），逐轮仅当索引变化时补发。
  视野确认：同文本跳过之外，扫会话 surface 确认提醒仍在视野内（compaction/rewind 会把启动注入挤出视野），丢了才补发（对齐 mnemon `cueAlreadyVisible`，《调研笔记》§1.2）——否则长会话 compaction 后记忆静默消失，等于换通道复发老毛病。
  双保险：standard preset 下 section 侧只保留一条静态路由指引（组合策略按实机实测定，《方向方案》A3 倾向"消息通道为主 + section 留静态一条"）。
  新通道挂 config 开关（如 `injectChannel`），默认关、cordis.patch.yml 显式开，沿用 `enabled` 的显式开启模式。
- **【依据】** 《方向方案》批 A1/A3；《调研笔记》§4.4、§6#1——三家竞品与官方 agent-instructions 全走此通道，本仓现网 section 注入是"唯一踩在坑边上的"。
- **【验收】** minimal 预设下四段内容出现在模型可见消息流；standard 下行为不劣化；compaction 后视野确认能补发；开关切回 section 即回滚。
- **【优先级】** P0（本版主菜）。
- **【来源】** 调研方案（批 A1/A3 + 审查 P1-1 视野确认）。

### M3 批 A2：防自食与去重（含 subagent 决策落点）

- **【做什么】**
  通道迁移后注入消息会以 user 身份进入事件流，两处统一按 `source.kind`（`"plugin"` / `"plugin:"` 前缀）过滤：
  `lib/transcript.js` 的 `hasEnoughUserProse`（:39-48）——不过滤则注入长文必过 ≥3 词门槛，skip 门槛被架空，纯注入轮白烧提取调用；
  `renderTranscript`（提取输入渲染）——不过滤则注入内容以"用户发言"身份进提取 prompt 被记回记忆。
  resume/启动去重走 `session/event` 订阅 + `sessionProjections` 记账（rc.2 已有；不用 alpha 已 deprecated 的 `ownEvents()`，避免二次迁移）。
  subagent 会话显式决策（调研倾向：排除注入、提取维持现状观察）。
  补「纯注入批次必须 skip 提取」断言。
- **【依据】** 《方向方案》批 A2 与审查记录"自家适配盲区"（审查员代码级实证两处过滤落点）；《调研笔记》§2.1/§3.1（hindsight/openviking 同款过滤与 subagent 跳过）。
- **【验收】** 注入内容不进提取输入；纯注入轮不触发 LLM 提取调用（测试断言）；resume 不重复注入。
- **【优先级】** P0（与 M2 配对，M2 落地不得缺 M3）。
- **【来源】** 调研方案（批 A2 + 审查 P1-2/P2-1）。

### M4 批 A4：检查与文档同步

- **【做什么】**
  新增注入面测试：minimal preset 场景模拟、双通道开关矩阵、纯注入批次必 skip 断言。
  现有 239 测试全部通过不回退；`test/inject-sections.test.mjs` 与 `test/client-source.test.mjs`（防漂移检查）测试面同步。
  README 同步：「不向任何 session append 事件」不变量表述推翻重写（README.md:69、:262 两处），已知限制/工作原理/FAQ 联动更新；版本号回写。
- **【依据】** 《方向方案》批 A4 与审查 P2-5（README 不变量与测试面将被批 A 推翻，未列同步项即欠账）。
- **【验收】** 全部检查绿；README 无失效表述；版本字段与发布内容一致。
- **【优先级】** P0（收尾件，随 M2/M3 同批完成）。
- **【来源】** 调研方案（批 A4 + 审查 P2-5）。

### M5 工程卫生：check 脚本跨平台 + 版本纪律

- **【做什么】**
  ① `npm run check` 由 bash for-loop（`for f in lib/*.js; do node --check "$f" || exit 1; done`，见 package.json scripts）改为 `node -e` 单行实现，Windows cmd 原生可跑，零新增依赖；
  ② 版本纪律：本版提交时 package.json 回写 0.2.0，并确立"每施工批提交同步 bump 版本"的规矩（本次 0.1.0 挂 10 批即失守的实证）。
- **【依据】** package.json scripts.check 现状（bash 语法，cmd 下直接报错）；version 0.1.0 vs git log 9 批。
- **【验收】** cmd 与 bash 双跑 `npm run check` 均通过；版本字段与本 ROADMAP 一致。
- **【优先级】** P1。
- **【来源】** 新发现（审查）+ 仓内遗留。

### M6 批 B2（候选）：fallback 换道接线

- **【做什么】**
  把 inert 的 `fallback` 配置接进提取调用链：主道 attempt 链不可恢复失败后，逐条 fallback 路由以同一 attempt 链调用，成功记 `fallbackUsed` 并落盘。
  接线点已在代码注释中标注（lib/index.js:586-589）；metrics 字段与面板分桶位已备（lib/metrics.js:27/117，lib/panel-logic.js:256 `EXTRACTION_BUCKET_KEYS` 已含 fallbackUsed）——纯接线，无新面。
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
| 1 | 消息通道注入污染用户对话流（UI 可见、用户困惑） | `source.kind` 标记 + 实机验证 UI 呈现（R8）；回滚 = `injectChannel` 开关切回 section，config 热载（web HMR / desktop 重启），不动数据 |
| 2 | compaction/rewind 把注入挤出视野，记忆静默消失（换通道复发老毛病） | M2 视野确认 + metrics 记账注入次数/字符（可观测）；测试钉 compaction 场景 |
| 3 | 通道迁移回归（现有 239 测试面部分被推翻重建） | M4 检查矩阵先行补齐再迁移；`inject-sections.test.mjs` 重写为双通道开关矩阵；全部通过才算完 |
| 4 | 提取自食（注入内容被记回记忆） | M3 两处过滤 + 纯注入批次必 skip 断言；审查员已实证过滤落点 |
| 5 | 免费池 429 重演（10-09 事故） | 退避链已有（732c3a6）；若 M6 随版则换道兜底，否则维持现状并在 v0.3.0 首位 |
| 6 | 官方插件入场挤压（时间窗已开） | M7 对照评估定批 C 去留；生态位（本地/markdown/可 git/观测面/跨 agent 复用）官方大概率不占 |
| 7 | 版本与推送纪律失守重演 | M5 版本纪律；732c3a6 未推送与 README 未提交改动应在批 A 首个施工提交前收口（发布动作另行确认，本 ROADMAP 不代做） |

每批三件套纪律照旧：检查全部通过 + 可观测（metrics/面板）+ 回滚开关（config 显式、默认旧路径）。

## 待确认项

1. **版本号**：推荐 v0.2.0（行为契约变化：README 不变量推翻 + 新 config 键 + 用户可感知变化）；备选 0.1.1（纯 patch 语义，不匹配本批体量）。
2. **M6 fallback 接线是否随 v0.2.0**：推荐随（纯接线、观测面已备、R6 直接对策、成本低）；若求单批聚焦可顺延 v0.3.0 首位，不阻塞。
3. **双保险组合**：推荐"消息通道为主 + section 保留一条静态路由"（《方向方案》A3 倾向，mnemon 三保险同构）；备选"完全删除 section"（更彻底，但 standard 下少一层兜底）。
4. **subagent 会话取舍**：推荐"排除注入、提取维持现状观察"（《方向方案》A2 倾向；hindsight/openviking 均整体跳过，我们取更温和的半排除）。
5. **嵌入服务选型**（v0.3.0 前置，本版只挂账）：本地 ollama / 现有免费池 / 付费 API + 隐私边界（记忆文本出不出本机）——《方向方案》待确认 #2 原样移交。
6. **新通道默认状态**：推荐 config 默认关、cordis.patch.yml 显式开（对齐 `enabled` 模式与"开关默认关"工作规矩，实机验证后再转默认开）；代价是发布初期用户需显式配置才吃到 P0 修复。

---

## 附：执行顺序与取证口径

- 建议执行顺序：M1 先行出结论（与 M2 同批开工）→ M2+M3+M4 一体闭环（通道迁移、防自食、检查文档拆开即回滚风险）→ M5 工程卫生收尾；M6 若确认随版则插在 M4 后、M5 前；M7 挂日历（官方插件发布后一周内），不阻塞任何任务。
- 取证口径（2026-10-13 对抗审查亲验）：M1 四段 text 函数 try/catch→return ""（lib/index.js:854-927）、M6 fallback inert 注释（lib/index.js:586-589）、U7 预留位（lib/api.js:299）、README 不变量两处（:69、:262 行号精确对上）、metrics/面板分桶位（lib/metrics.js:27/117、lib/panel-logic.js:256 EXTRACTION_BUCKET_KEYS 含 fallbackUsed）均已开码对证；《方向方案》批 A1-A4 与《调研笔记》§4.4 的引用逐条比对一致，宿主 `complete:true` 整体替换语义在调研 sources 的 dsh-system-prompt 源码（assemble() "an effective complete section is restored afterwards as the sole prompt section"）审查成立；239 测试审查当日复跑全部通过。
- 维护约定：任务完成即勾销并注明提交号；新增任务必须有仓内证据或调研文档出处，禁止凭空造功能。
