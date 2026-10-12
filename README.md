# dsh-memory

> **[English](README.en.md) | 中文**

> DSH（DeepSeek Harness）的跨会话记忆插件：对话里聊过的事自动记下来，下次对话自动带上——你不用每次重复交代背景。附带一个本地「记忆管理」面板，记了什么、删了什么、人设怎么设，全程可见可改。

- **插件版本**：0.2.0（以 `package.json` 为准）
- **适配宿主**：DSH 0.2.0-rc.2（web / headless / desktop 三个 profile 均可安装）
- **数据位置**：全部在本地 `~/.dsh/memory/`，不上传任何远端；API 与面板仅本机（loopback）可访问
- **前置条件**：已安装 DSH（web / headless / desktop 任一 profile）；Node ≥ 18；**零运行时依赖**（无需 `npm install`）
- **许可**：MIT License（见 [LICENSE](LICENSE)）

设计参考同类 agent 的项目记忆子系统；v1 采用单次 LLM 调用简化提取。

## 目录

- [这是什么](#这是什么)
- [功能介绍](#功能介绍)
  - [自动记忆：会话结束自动提炼，下次对话自动带上](#自动记忆会话结束自动提炼下次对话自动带上)
  - [语义召回（可选）](#语义召回可选)
  - [记忆管理面板](#记忆管理面板)
  - [管道健康卡与「立即重试提取」](#管道健康卡与立即重试提取)
  - [失败韧性：重试、分类、落盘留痕](#失败韧性重试分类落盘留痕)
  - [自动备份](#自动备份)
- [快速开始](#快速开始)
- [配置](#配置)
- [数据与隐私](#数据与隐私)
- [回滚与卸载](#回滚与卸载)
- [FAQ](#faq)
- [工作原理](#工作原理)
- [可观测与运维](#可观测与运维)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)

## 这是什么

DSH 每次新会话都是从零开始：你的工作背景、这个项目的决策历史、上周聊定的口径，全都得重新说一遍。dsh-memory 把这件事自动化：

1. **自动提取**——每轮对话结束，插件自动判断这轮有没有值得记的事（用户偏好、项目决策、长期有效的结论……），有就落盘成本地 Markdown 文件；
2. **自动注入**——之后每一轮对话，把已记下的内容以四段形式（人设 / 全局记忆索引 / 项目使用说明 / 项目记忆索引）作为一条插件自有的用户消息注入会话，模型据此"记得"你；
3. **面板管理**——DSH 设置页多一个「记忆」区块，从这里打开记忆管理面板：浏览/编辑/删除/导入导出记忆条目、编辑人设与称呼、开关各路记忆、看提取管道健康状况。

记忆分两层：

- **全局记忆**（跨所有对话生效）：工作背景、用户个人背景、当前关注、近期动态（自动滚动清理，默认保留 30 条 / 30 天）四个对话分类，外加长期记忆；
- **项目记忆**（按工作区路径隔离）：每个项目一个独立目录，记这个项目的决策与状态。

## 功能介绍

以下每条都有源码依据（`lib/` 与 `web/`），按"用户看到什么 / 能得到什么"叙述。

### 自动记忆：会话结束自动提炼，下次对话自动带上

- **无需手动操作**：每一轮对话正常结束（`turn/end` 且 `reason.kind === "completed"`）后自动触发一次提取判断；纯寒暄、命令式短句（不足 3 个词的用户散文）这类没内容可记的轮次自动跳过，不白花 token。
- **增量提取**：插件为每个会话维护提取进度（cursor），只提炼新完成的轮次；提取失败时进度不推进，下一轮自动连本带利重提（自动补提），不会漏记也不会重复记。
- **提取走会话路由**：默认复用你当前对话所用的模型路由（与 session-title 同款捕获策略），不单独配置也能跑；也可以在 `cordis.patch.yml` 显式指定更稳的 `provider` / `model`。
- **跨会话四段注入**：之后每轮对话，插件把记忆作为一条**插件自有的用户消息**注入会话（默认走 durable 消息通道，对所有预设——包括 `complete:true` 的极简预设——都生效，这是 v0.2.0 对旧版"极简模式静默失忆"的根治点；`injectChannel: "section"` 可回退到旧的系统提示词注入）。这条消息由四段组成，模型据此"记得"你：

| 注入段 | 模型看到什么 | 预算 |
|---|---|---|
| 人设 | 「用户叫你小舟」「希望你称呼他为老板」+ 你编辑的补充人设正文 | 400 行 / 16k 字符 |
| 全局记忆索引 | 四分类 + 长期记忆的条目索引；近期动态带年龄与过期倒计时（如「3 天前 · 27 天后过期」） | 每类 40 行，总 120 行 / 12k 字符 |
| 项目使用说明 | 记忆目录在哪、索引怎么读、怎么按你的要求直写/删除记忆 | 固定短文 |
| 项目记忆索引 | 该项目 `MEMORY.md` 索引（每行指向一个记忆文件，模型按需 Read） | 200 行 / 25k 字符，超限保最新丢最旧并附 WARNING |

- **三层开关**（面板「设置」页，改动下一轮对话即生效）：

| 开关 | 关掉后的效果 |
|---|---|
| 对话记忆（总开关） | 四段注入全灭 + 自动提取全停；关掉期间的轮次不积累，重开后不回补 |
| 项目记忆 | 项目使用说明/项目索引不再注入，项目类记忆写入被过滤（计数可见） |
| 全局自动提取 | 不再自动写全局记忆；已有的全局条目照常注入 |

- **防自反馈**：注入的记忆消息带 `source.kind = "plugin:dsh-memory"` 标记；提取侧按此标识把自家注入的消息从「用户散文」里排除（既不计入 skip 门槛、也不进提取输入），不会出现"模型把注入的记忆又记回记忆"的自食循环。

### 语义召回（可选）

默认关闭。开启 `recallEnabled` 并配好嵌入端点（`embeddingBaseUrl` / `embeddingModel`）后，每轮对话会按你**当前的问题**语义检索最相关的记忆条目（嵌入余弦 top-k），以 `<memory-recall>` 块注入——不必等模型按索引主动 Read。条目向量按内容增量缓存，只有新写/改动过的条目才重新嵌入。

- **默认关**：不配置端点就不产生任何外部调用（记忆文本不出本机）；指向本地端点（如 ollama `http://127.0.0.1:11434/v1/embeddings`）则记忆文本也不出本机。
- **自带模型（provider-agnostic）**：插件不绑定任何嵌入模型或厂商——只要你的服务提供 OpenAI 兼容的嵌入端点（绝大多数本地部署都提供），填上 `embeddingBaseUrl` + `embeddingModel` 即可，本地自选模型（nomic-embed-text、bge-m3、embed-model…）同样适用。`embeddingProvider` 只是显示标签，配不配都行。
- **失败显式降级**：端点超时/报错时本轮不召回（不阻塞、不臆造），计数进 `/state.recall`。

### 记忆管理面板

入口：DSH 设置页「记忆」区块（门牌）→「打开记忆管理」。打开方式自动三级降级（新窗口 → 内嵌 iframe → 整页跳转），面板主题自动跟随宿主深浅色。门牌本身也是速操台：总开关、「DSH 的名字」「对我的称呼」两个输入框（防抖自动保存）、状态摘要（全局 N 条 · M 个项目）、提取失败红条 + 「详情」深链。

![记忆管理面板：分类条目管理](docs/panel.png)

![设置页：三层开关与提取管道健康卡](docs/panel-settings.png)

> 上图为界面示意（使用示例数据渲染）。

面板（`/dsh-memory/panel/`，仅本机可访问）包含：

- **四个对话分类页 + 长期记忆页**：条目卡片流（标题 / 描述 / 文件名 / 更新时间 / 正文），支持——
  - **浏览与检索**：长期记忆页有即时过滤（标题 / 描述 / 正文）；近期动态条目带年龄徽标；
  - **编辑**：标题（60 字）、描述（60 字）、正文（20000 字符上限），实时字符与 UTF-8 字节计数；
  - **删除**（确认弹窗）、**新增条目**；
  - **源码模式**：整类序列化成一个文本直接编辑，保存 = 先自动备份再整类重建；
  - **重置**：清空整类（先自动备份）；
  - **导入**：支持上传 `.json` / `.md` 文件（≤2MB）或直接粘贴，三种格式（JSON 结构化逐条 / Markdown 按 `##` 拆条 / Markdown 整段）；先预览将要写入的条目（与现有内容冲突或批内改名的标红），确认后才落盘（落盘前自动备份）；批内同名自动 `-2` / `-3` 避让。
- **人设页**：左右分栏（markdown 编辑 + 实时预览），内置简洁 / 专业 / 幽默 / 伙伴 / 自定义五个预设模板，一键套用；「恢复默认」回到出厂模板（先自动备份）；上限 100KB。人设是官方系统提示的**补充**而非替换，对所有回复生效。
- **称呼页**：「DSH 的名字」「对我的称呼」两个输入框（各 40 字上限），防抖自动保存，与门牌输入框是同一份数据。
- **项目记忆页**（只读概览）：按工作区列出各项目的条目数与最后更新时间；可单项目导出 JSON。项目记忆由对话自动维护，不提供手工编辑。
- **设置页**：三层开关；管道健康卡与提取模型卡（见下节）；数据卡（**导出全部** JSON / **清空全部记忆**——逐类自动备份，人设与称呼保留）；备份列表（最近 20 份，逐份可「恢复此备份」，恢复前还会先备份当前状态）。
- **损坏可见**：`settings.json` / `addressing.json` / `persona.md` 解析失败时，门牌与面板显示红条「解析失败（已按缺省运行）」，点任意开关 / 重新保存对应内容即可重写修复；人设 / 称呼的损坏档在覆盖写前自动备份 `*.corrupt-<ts>`，原数据不失访（`settings.json` 无备份、改开关时直接重写修复）。

### 管道健康卡与「立即重试提取」

设置页的「自动提取管道」健康卡让你一眼看出记忆提取是否健康：

- **三态灯**：绿 = 最近无失败（折叠为一行摘要）；黄 = 近期有过失败但已自动恢复；红 = 当前连续失败（同因连击数）；灰闪 = 正在提取。连击 > 0 期间每 5 秒自动轮询刷新，侧栏「设置」项同步显示红色连击徽标。
- **失败分桶计数**：按原因（无路由 / 无 cwd / LLM 调用 / 解析 / 落盘 IO）分桶，只显示非零桶。
- **最近 5 条失败详情**：时间 / 原因 / 模型 / 错误摘要，配合失败日志路径（`<storageRoot>/extraction-errors.log`）排障。
- **错过区间提示**：「seq X 之后的轮次尚未记录，恢复后自动补提」——告诉你哪些对话可能漏记了。
- **「立即重试提取」按钮**：对仍有未提取区间的会话真的发起一次 LLM 提取（有确认弹窗，明示消耗少量 token）；点击后按钮进入 busy 态，面板每 2 秒轮询状态最多 60 秒，恢复即提示「提取已恢复」。10 秒最小间隔，提取在途时返回 409。
- **「复制诊断信息」按钮**：一键复制当前状态摘要，可直接粘贴到 issue。
- **提取模型卡**：如实展示提取路由（显式配置的 `provider`/`model`，或「未指定（跟随会话路由）」）、fallback 换道配置、最近一次提取用车（路由 + 相对时间）、嵌入模型（语义召回所用；未配置时显示为未启用）。

### 失败韧性：重试、分类、落盘留痕

提取是后台静默发生的，所以失败处理必须显式可见：

- **可取消退避重试**：单次提取最多 3 次 attempt（含首次），指数退避 500ms 起步、2s 封顶（jitter ±20%）；上游带 `Retry-After` 时优先采用（钳制防恶意长等）。插件卸载/进程退出时退避立即中断，不白等。
- **失败分类**：按内核 `failure.code` 判可重试（EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT）；AUTH / INVALID_REQUEST / QUOTA 这类确定性失败立即摊牌，不浪费 attempt。
- **换道兜底**（v0.2.0）：主道 attempt 链不可恢复失败后，按 `fallback` 配置逐条换道（换道同样走完整 attempt 链）；换道成功计入 `/state` 的 `fallbackUsed` 并把最近用车指向该道。未配置 `fallback` 时行为与纯重试完全一致。
- **失败落盘日志**：每次提取失败追加 `<storageRoot>/extraction-errors.log`——常开，不依赖任何环境变量；只记摘要（时间 / pid / 原因 / 路由 / 错误摘要），**不含会话内容**；超过 512KB 轮转两档。
- **结构性失败显式放弃**：无路由 / 无 cwd 这类重试不可能自愈的失败，连续 5 次后显式放弃该区间并记 error 日志，不无限积压。
- **单条容错**：模型输出里个别畸形操作跳单处理（好条目照常落盘）；单条 IO 失败隔离上报，不阻断整批。

### 自动备份

所有批量破坏性操作都有后悔药：

- **自动全量备份**：重置分类 / 确认导入 / 恢复备份 / 重置人设 / 清空全部之前，自动把当前 `global/` + `settings.json` 全量备份到 `<storageRoot>/backups/<时间戳>/`；
- **滚动保留最新 20 份**，防无界累积；
- **半备份可见且拒恢复**：备份采用两段式落盘（先 `complete: false`，拷完改 `true`），中断的半备份在面板标「不完整」且拒绝恢复；
- **恢复也有后悔药**：恢复备份前先把当前状态再备份一份（`pre-restore`），恢复中途失败时响应会带上这份备份 id 指路自救。

## 快速开始

### 安装

本插件经 **git 安装**（`dsh plugin add <本仓库的本地克隆路径或 git URL>`）；零运行时依赖，无需 `npm install`。

```bash
dsh plugin --profile web add <克隆到本地的仓库路径>   # 或 git URL；profile 可选 web / headless / desktop
dsh --profile web --dump-config                    # 验证 entry 入树
```

三个 profile 的安装均为 **symlink（`link:<克隆路径>`）**，源码改动无需同步拷贝；但运行中的 desktop 实例吃到新代码需 HMR 重载或重启应用（headless 每次启动天然取最新）。

安装即启用：`cordis.patch.yml` 显式 `enabled: true`（代码缺省关，fail-closed），开关状态在 YAML 里可见。

### 验证生效

1. 装好后开一个新会话，正常聊几轮有实质内容的话（整句散文，而非单词命令）；
2. 检查落盘：看 `~/.dsh/memory/projects/<slug>-<hash16>/memory/` 是否出现 `MEMORY.md` 与记忆文件，或全局分类目录（如 `~/.dsh/memory/global/work-profile/`）是否出现条目；
3. 检查注入：新开一轮对话，让模型复述"你记得关于我/这个项目的什么"，能引用出记忆内容即注入生效；
4. 也可直接查 API：`GET /dsh-memory/api/state`（本机 loopback）看 `counts`（全局条目数 / 项目数）与 `extractionFailures`（应为全零）；
5. 打开 DSH 设置页 →「记忆」区块 →「打开记忆管理」，面板各页应能正常浏览。

注意：desktop / headless profile 改 `cordis.patch.yml` 等 entry config 后需重启对应实例才生效（web profile 由 HMR 自动生效）；而面板里的三层开关、称呼、人设走 `~/.dsh/memory/settings.json`，宿主每轮读取，**下一轮对话即生效，无需重启**。

## 配置

cordis entry config（见 `cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | **false（代码缺省关，fail-closed）** | 总开关；`cordis.patch.yml` 显式 `enabled: true`，安装即启用且开关可见于 YAML |
| `injectChannel` | **`"message"`** | 注入通道：`"message"`=durable 用户消息通道（默认，全预设生效）；`"section"`=旧四段 systemPrompt 注入（一键回滚） |
| `injectMaxChars` | 60000 | 消息通道注入总预算（字符）；超限按优先级整段丢弃并附可见 WARNING |
| `storageRoot` | `~/.dsh/memory` | 记忆总根（测试/迁移用，一般不动） |
| `provider` / `model` | 空（跟随会话路由） | 提取调用的模型路由；成对出现，否则报错。缺省时自动捕获本会话路由（`request/header` 优先，`assistant/message` 的 `source` 兜底，同 session-title 策略） |
| `minUserWords` | 3 | skip 条件的散文词数下限 |
| `timeoutMs` | 120000 | 单次提取调用超时 |
| `maxOutputTokens` | 4096 | 提取输出上限 |
| `maxIndexLines` / `maxIndexChars` | 200 / 25000 | 注入截断预算 |
| `maxManifestFiles` | 200 | manifest 文件数上限 |
| `maxPromptChars` | 48000 | 增量 transcript 截断 |
| `maxOps` | 20 | 单轮最多写/删条数 |
| `recentKeepCount` / `recentKeepDays` | 30 / 30 | 近期动态滚动清理：最多保留条数 / 最大年龄天数 |
| `retryAttempts` | 3 | 提取 LLM 调用总 attempt 数（含首次） |
| `retryBackoffMs` / `retryMaxDelayMs` | 500 / 2000 | 指数退避首档与上限（jitter ±20%；上游带 Retry-After 时优先、钳 ≤3×上限） |
| `fallback` | []（纯重试不换道） | 换道路由 `[{provider, model}]`，≤3 条、去重、不得撞主道。主道 attempt 链耗尽后逐条换道（同 attempt 链），成功记 `fallbackUsed` 且最近用车指向该道；未配置则与纯重试一致 |
| `embeddingModel` | 空 | **你的**嵌入模型标识。开启 `recallEnabled` 后必填——它同时是向量空间的缓存身份（换模型＝整库重嵌）。填你端点上的模型名即可，如 `nomic-embed-text`、`bge-m3`、`text-embedding-3-small` |
| `embeddingProvider` | 空 | 可选，纯面板显示标签，不参与调用，**不要求与 `embeddingModel` 成对**（如 `ollama` / `lmstudio`） |
| `recallEnabled` | **false** | 语义召回总开关；开启需配 `embeddingBaseUrl` + `embeddingModel`（缺一启动即抛，fail loud） |
| `embeddingBaseUrl` | 空 | 你的嵌入端点，**任意 OpenAI 兼容服务即可（本地或远程）**：`POST <url>`，体 `{model, input}`，返回 `{data:[{embedding}]}`（也容忍 `{embedding}` / `{embeddings}` 两种本地常见形态）。仅接受 `http(s)`。示例：ollama `http://127.0.0.1:11434/v1/embeddings`、LM Studio `http://127.0.0.1:1234/v1/embeddings`，vLLM / TEI / llama.cpp 同形；远程如 `https://api.openai.com/v1/embeddings` |
| `embeddingApiKey` | 空 | 端点鉴权（可选；有则带 `Authorization: Bearer`） |
| `recallTopK` / `recallMaxTokens` | 5 / 1200 | 单轮召回条数上限 / 召回块 token 预算（CJK 感知估算） |
| `recallMinScore` | 0.35 | 余弦相似度阈值（[0,1]，越界即抛） |
| `recallTimeoutMs` | 8000 | 单次嵌入调用超时。**实机实测**：本地 CPU 嵌入服务独立调用 ~0.6s，但**宿主进程内**竞争下可达数秒——故默认留足余量；端点真死会连接被拒秒退，只有慢端点才吃满（超时按失败降级：本轮不召回） |

失败分类：按内核 `failure.code` 判可重试（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT），AUTH/INVALID_REQUEST/QUOTA 等确定性失败立即摊牌；code 缺失才退保守 message 正则。

配置严格性：未知 config 键即抛错（带 did-you-mean 建议），非法值即抛——fail loud，不静默吞错配。

## 数据与隐私

- **数据全在本地**：所有记忆、设置、备份、日志都落在 `~/.dsh/memory/`（自有目录，卸载不影响其他组件）；
- **提取走会话路由**：提取调用复用你当前对话的模型通道（`ctx.llm.stream`），没有独立的云端上传路径；
- **失败日志不含会话内容**：`extraction-errors.log` 只记时间 / pid / 原因 / 路由 / 错误摘要；诊断口 `debug.log` 仅在 `DSH_MEMORY_DEBUG=1` 时开启；
- **API 与面板仅本机可访问**：全部端点先过 loopback 守卫（仅 127.0.0.1 / localhost，校验 Host 与 Origin），DSH 反代鉴权是第一层。

数据布局：

```
~/.dsh/memory/
├── settings.json                          # 三层开关（面板可改，每轮读取）
├── extraction-errors.log                  # 提取失败日志（常开，>512KB 轮转两档）
├── debug.log                              # DSH_MEMORY_DEBUG=1 时的诊断口
├── embeddings.json                        # 语义召回条目向量缓存（开启 recallEnabled 时生成）
├── global/                                # 全局记忆
│   ├── persona.md                         # 人设（出厂默认模板起步）
│   ├── addressing.json                    # 称呼 {dshName, userAlias}
│   ├── work-profile/  user-profile/  current-focus/  recent-activity/  long-term/
│   │   └── MEMORY.md + <kebab-name>.md    # 每类：索引 + 条目
├── projects/<slug>-<hash16>/memory/       # 项目记忆（按工作区隔离）
│   ├── MEMORY.md                          # 索引：- [Title](file.md) — 一行钩子（≤150 字符）
│   └── <kebab-name>.md                    # 记忆文件：frontmatter name/description/metadata.type
└── backups/<ts>/                          # 自动备份（滚动保留最新 20 份）
```

- `slug`：workspace basename 净化（小写、`[^a-z0-9._-]+`→`-`、截 48、空则 `project`）
- `hash16`：绝对路径（win32 转小写）sha256 前 16 hex
- 记忆文件格式（frontmatter / 索引行 / `[[name]]` 互链 / 跨 agent 互认约定）见 [FORMAT.md](FORMAT.md)

## 回滚与卸载

1. **停功能不卸包**：把 profile 的 `cordis.patch.yml`（或 bundle patch）里 `enabled` 改为 `false`。生效方式分 profile：**web profile 由 HMR 自动生效；desktop/headless 改 config 后需重启对应实例**（桌面端重启应用；headless 本就每次启动新进程）。不存在"改完即热生效"的统一行为，以上为各 profile 的实际生效路径。若只想临时停用记忆功能，用面板的总开关即可（下一轮对话生效，无需重启）。
   - 只回退**注入通道**（不停功能）：把 `injectChannel` 改为 `"section"`，回到旧的四段系统提示词注入；同样按上面的 profile 生效路径。
   - 只关**语义召回**：把 `recallEnabled` 改为 `false`（或删除），回到"仅索引、无自动召回"，不再产生任何嵌入调用。
2. **整包卸载**：`dsh plugin --profile <name> remove dsh-memory`。
3. **清数据**：删 `~/.dsh/memory/`（自有目录，不影响其他组件）。

## FAQ

**Q1：改了配置 / 关了开关，怎么没生效？**
分两层。`cordis.patch.yml` 里的 entry config（provider/model、预算等）改完后，web profile 走 HMR 自动生效，desktop / headless 需重启对应实例。而面板里的三层开关、称呼、人设不走这套——它们写在 `~/.dsh/memory/settings.json`，宿主每轮对话前读取，下一轮对话即生效，不受重启限制。

**Q2：设置页红条「自动提取失败 N 次」是什么？怎么办？**
这是提取管道在报障（典型场景：免费池限流 429）。长这样：门牌/面板出现红条，健康卡灯变红、显示连击数、失败分桶、最近失败详情和「seq X 之后的轮次尚未记录」的错过区间提示。插件会自动重试（3 次 attempt 指数退避）并在此后每轮自动补提；如果长期不恢复，到设置页健康卡点「立即重试提取」，或看 `<storageRoot>/extraction-errors.log`（健康卡上有路径），或在 `cordis.patch.yml` 给 dsh-memory 显式配一组更稳的 `provider`/`model`。

**Q3：手动编辑条目/人设时粘贴错了并保存，能找回吗？**
不能——单条覆盖写（保存条目、保存人设、改称呼）是直接替换旧文，没有编辑历史（有意不修，见已知限制）。有自动备份的是批量破坏路径（重置 / 导入 / 恢复备份），单条覆盖前请自行先导出兜底。

**Q4：刚聊的事为什么没被记下来？**
依次排查：① 该轮没有 ≥3 个词的用户散文（如只有单词命令）会被 skip——这是降噪设计；② 你（或模型）在该轮直接写入了记忆目录，直写轮会跳过自动提取；③ 提取失败（看红条/健康卡）；④ 三层开关被关了。任何情况下都可以在面板手动新增条目补上。

**Q5：我的对话内容会被上传到哪？**
记忆数据全部落在本地 `~/.dsh/memory/`。提取调用本身走你当前会话的模型路由（和你对话用的是同一条通道，发给它的是增量对话摘录 + 现有记忆索引）；失败日志只记错误摘要，不含会话内容。API 与面板仅本机 loopback 可访问。

**Q6：「立即重试提取」为什么提示间隔过短？**
该按钮有 10 秒最小间隔节流（真调 LLM 的端点必须有闸；进程内计时，重启插件会重置）；提取在途时会返回 409「已有提取在进行中」。稍候再点即可。

## 工作原理

内核机制视角（实现语义，供二次开发/排障参考）：

- **触发**：订阅 `session/event`，在 `turn/end`（`data.reason.kind === "completed"`）后触发提取（进程内单飞 + latestPending 合并：running 期间新触发只留最新边界）。
- **提取**：`ctx.llm.stream` 单次调用——输入为增量 transcript 摘录 + 现有记忆 manifest（mtime 降序前 200，最近小文件附正文）+ 全局四分类索引现状，输出为 `Nothing to save.` 或一个 `{"ops":[...]}` JSON（ops 带 scope：`project` 缺省 / `global:<category>`）。
- **落盘**：由插件（非模型）写文件到 `~/.dsh/memory/projects/<slug>-<hash16>/memory/` 或全局分类根，文件名经三道闸（包含性判定 + 黑名单段 + Unicode 控制符剥除）；`MEMORY.md` 索引自动合并维护；`recent-activity` 的时间戳由宿主盖章（不信模型报的时间）；近期动态滚动清理在启动时 + 每次全局写入后收口。
- **注入**：默认走 durable 用户消息通道——每轮第一个 step 在 `agent/pre-step` 求值四段（4990 人设 / 4995 全局记忆索引 / 5000 项目使用说明 / 5001 项目 `MEMORY.md` 索引），拼成一块带 `<memory-context>` 包裹的 user 消息注入（块首一行免责/署名：记忆是参考上下文、非任务指令；subagent 会话不注入）；与视野内已有注入内容相同则跳过（内容变化或 compaction/rewind 把旧注入挤出视野时才补发），总预算 `injectMaxChars`。`injectChannel: "section"` 时回退为四段 `ctx.systemPrompt.section` 注入（空段自动丢弃；索引读取有 mtime 缓存，缓存键含项目维度，防同 size+mtime 串档）。
- **语义召回**（可选，`recallEnabled`）：开启后每轮以当前用户消息为查询，对记忆条目做嵌入余弦 top-k（`recallTopK`/`recallMinScore`/`recallMaxTokens`），命中的条目以 `<memory-recall>` 块经消息通道注入；条目向量增量缓存于 `<storageRoot>/embeddings.json`（仅新/改条目重嵌），**查询每轮嵌入一次**。端点超时/失败/未配置 → 本轮不召回（**显式降级**，`/state.recall` 可观测）；记忆文本会发往 `embeddingBaseUrl`（默认关＝不配置就不出本机，指向本地端点即不出本机）。
- **skip 双条件**：无 ≥3 词用户散文；本轮已有对记忆目录的直写（write/edit 工具落 memoryRoot）。skip 也推进 cursor。
- **cursor 推进纪律**：run 结算 'ok'（成功或 skip）推进到快照边界；'error' / abort 不推进，下轮合并重提。cursor 为进程内状态不持久化；插件中途挂载/恢复的会话只提取存活期间新完成的轮次，不回扫历史。
- **关停纪律**：插件卸载时先有界 drain 在途提取（headless one-shot 依赖这段在退出前把记忆写完），超时才 abort 兜底。
- **六条规格边界**：① 去抖合并+cursor 推进 → `lib/state.js`；② 写入边界（仅 .md、包含性强制、模型永不直接碰盘）→ `lib/extract.js`；③ 文件名安全 → `lib/filename.js`；④ 注入预算 → `lib/manifest.js`；⑤ 触发门槛 → `lib/transcript.js`；⑥ 防自反馈（提取 request-only + 注入消息按 `source.kind` 过滤）→ `lib/index.js` / `lib/transcript.js`。

## 可观测与运维

- **提取失败计数**：`/dsh-memory/api/state` 的 `extractionFailures`（按原因分桶 + 同因连击 streak + `retried` 重试 attempt 计数 + `recent[5]` 最近失败详情）；门牌/面板红条显示连续失败。结构性失败（无路由/无 cwd）连续 5 次后显式放弃该区间（error 日志），不再无限重试积压。
- **观测面**：`/state` 另含 `lastFailedRange`（未恢复失败区间）/ `extractionInFlight` / `lastAttemptAt` / `lastUsedRoute`（最近一次提取用车）/ `extractionConfig`（含 fallback）/ `embeddingConfig`（嵌入召回配置）；面板设置页有「管道健康卡」承载以上全部。
- **注入面（v0.2.0）**：`/state` 的 `injection` 字段（`count` / `lastChars` / `totalChars` / `resends` / `droppedSegments` / `renderFailures` / `lastAt`）；面板健康卡附一行注入摘要（注入次数 / 最近字符 / 丢段 / 渲染失败）。渲染失败显式计入 `renderFailures`（不静默丢）。
- **召回面**：`/state` 的 `recall` 字段（`hits` 命中注入次数 / `items` 累计条目 / `chars` 累计字符 / `misses` 无命中 / `errors` 嵌入或检索异常 / `lastAt`）。
- **失败落盘日志**：每次提取失败追加 `<storageRoot>/extraction-errors.log`（只记摘要：时间/pid/原因/路由/错误摘要，不含会话内容；>512KB 轮转两档）。不依赖 `DSH_MEMORY_DEBUG`，常开——上游限流停摆场景里运行态零痕迹的补丁。单进程单写者前提；跨进程共享 storageRoot 不保证 interleave 安全。
- **手动补提**：`POST /dsh-memory/api/extract/retry`（面板「立即重试提取」按钮）→ 202 已触发 + 经 `/state` 观测结果；在途 409；10s 最小间隔（进程内计时，重启插件重置）。复用 scheduler 单飞，无并发双跑。
- **损坏可见**：settings.json / addressing.json / persona.md 解析失败=按缺省运行 + `corrupt` 标记 + 界面红条；覆盖写前损坏档自动备份 `*.corrupt-<ts>`。
- **debug 日志口**：`DSH_MEMORY_DEBUG=1` 时写 `<storageRoot>/debug.log`（>1MB 轮转两档 debug.log.1）——Electron 宿主 console 不回传时的全量诊断通道。
- **备份策略**：reset/import/restore 前自动全量备份到 `backups/`，滚动保留最新 **20 份**；半备份（meta 无 complete）标记 incomplete 且拒绝恢复。
- **逐项检查脚本**：`tools/m1-api-walkthrough.sh` 会清空目标宿主的记忆数据——默认拒绝执行，须显式 `WALKTHROUGH_CONFIRM=yes`（只对一次性验收容器跑）。

## 开发与测试

```bash
npm test    # node --test，309 个测试（含防漂移检查 test/client-source.test.mjs）
npm run check  # 语法快检 lib/*.js（跨平台 node -e 循环，cmd/bash 均可跑）
```

模块结构：`lib/index.js`（入口：订阅/路由捕获/重试链/注入）、`lib/inject-channel.js`（注入块拼装/预算裁剪/来源判据）、`lib/state.js`（提取状态机）、`lib/extract.js`（输出解析 + scoped 落盘）、`lib/transcript.js`（转录渲染与 skip）、`lib/manifest.js` / `lib/filename.js`（索引与文件名安全）、`lib/global-store.js`（全局记忆 CRUD/备份/恢复）、`lib/settings.js`（三层开关）、`lib/metrics.js`（失败计数/失败分类/退避/注入面）、`lib/errorlog.js`（失败日志）、`lib/api.js` + `lib/panel.js` + `lib/panel-logic.js`（REST API / 面板供给 / 面板纯逻辑，双端共享进检查）、`lib/client.js`（设置页门牌）、`web/panel.html`（面板单文件前端）。

## 已知限制

- **规格 taskType 过滤未移植**：上游规格按任务类型（interactive/fork/…）过滤提取资格；本插件对所有会话生效，依赖 skip 双门槛（无 ≥3 词散文 / 直写轮）兜底抑制噪声。
- **相对路径 file_path 的直写判定偏保守**：`transcript.js` 对 write/edit 的 `file_path` 以 memoryRoot 为基解析相对路径，恰好落在记忆目录内的相对路径会判为"直写轮"而 skip 提取——方向保守（多 skip、不漏存），安全。
- **单次 LLM 调用**（非提取子任务 loop 形态，其 API 面在 DSH 未实证）：更新老记忆时模型只见 manifest 描述 + 最近小文件正文，不见全部旧文；由 manifest 附正文（≤3000 字符 × 最近 10 文件）缓解。
- **防自反馈与检索**：提取调用为 request-only 输入（不 append 事件）；注入的记忆消息带 `source.kind = "plugin:dsh-memory"` 标记，提取侧按此排除（不计 skip 门槛、不进提取输入）——注入内容会出现在会话记录流中，但不会被记回记忆。记忆正文无自动检索，靠模型按索引主动 Read（与上游规格同构）。
- **desktop/headless 改 config 需重启实例**（见回滚节），无统一热生效。
- **单条覆盖写无编辑历史**（有意不修）：PUT persona / PUT entry 直接替换旧文——粘贴错内容保存即丢旧文；批量破坏路径（reset/import/restore）有自动备份，单条覆盖请自行先导出兜底。
- **4995 全局索引每次求值全量读条目**（有意不修）：近期动态条目渲染读取条目正文（只用 40 行预算），桌面规模无感；若条目数暴涨可加 mtime 缓存。
- **注入块在会话内可能累积**：记忆内容变化时补发新的注入消息、旧块不删（已提交历史不可改），仅靠 compaction 收敛；单块受 `injectMaxChars` 约束，`/state.injection.resends` 可观测累积速度。若长期高频变化，后续可考虑「同 form 只保最新」。
- **`injectMaxChars` 是软上限**：超限追加的可见截断提示行不计入预算，最终字符数可能略超该值（默认 60000 下不触发，仅护栏）。
- **防自食只覆盖自家注入**：提取侧按 `source.kind` 只排除 `plugin` / `plugin:*`；宿主官方 `agent-instructions`、`runtime-context` 等注入的 user 消息仍按普通用户内容对待（既有行为，非本版引入；本版保证的是"不把自己的注入记回去"）。
- **回声抑制是标签级**：提取输入会剥掉自家 `<memory-context>` / `<memory-recall>` 包裹块（防模型原样回声被记回）；若模型是"意译"引用而非原样带标签，剥离不生效——注入消息本身的排除靠 `source.kind`（M3）兜底，但意译文本不可辨。
- **语义召回按轮嵌入查询**：开启后每轮对当前用户消息嵌一次（受 `recallTimeoutMs` 约束，超时即本轮不召回）；条目向量增量缓存不重复嵌入，但**首次开启会一次性嵌入当时全部条目**。默认关，未配置端点时不产生任何调用。
- **召回块的会话内累积**：召回结果变化时补发新块、旧块不删（已提交历史不可改），仅靠 compaction 收敛；`/state.recall` 累计 `chars`/`items` 可观测。未做 supersede（与主注入同一取舍）。端点连续失败会熔断 60s（期间跳过召回，避免每轮阻塞）。
