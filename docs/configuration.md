# 配置参考

配置分两处，职责不同：

- **`cordis.patch.yml`（entry config）** —— 插件装载时读取，改了要按 profile 生效（`web` 走 HMR，`desktop` / `headless` 要重启）。
- **`~/.dsh/memory/settings.json`（面板可改）** —— 三层开关、运行时记忆开关、空闲整理开关、保留策略。宿主每轮读取，下一轮对话即生效，不用重启。

**写错位置会被拒**：把面板管的东西写进 `cordis.patch.yml`（如 `runtimeEnabled`）会因未知键报错；把 entry config 的东西写进 `settings.json` 不会生效。

配置严格性：未知 config 键即抛错（带 did-you-mean 建议），非法值即抛。fail loud，不静默吞错配。

## 核心

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false`（代码缺省） | 总开关。`cordis.patch.yml` 显式写 `true`，安装即启用 |
| `injectChannel` | `"message"` | 注入通道。`"message"` = durable 用户消息（全预设生效）；`"section"` = 旧 systemPrompt 通道（一键回滚，同样承载六段） |
| `storageRoot` | `~/.dsh/memory` | 记忆根目录（测试/迁移用，一般不动） |
| `provider` / `model` | 空（跟随会话路由） | 提取用的模型路由。成对出现，否则报错。缺省时自动捕获本会话路由 |
| `redactionEnabled` | `true` | 脱敏总开关。`false` = 完全不脱敏 |

## 注入预算

| 键 | 默认 | 说明 |
|---|---|---|
| `injectMaxChars` | 30000 | 注入总预算（字符口径）。召回块与主块共享，主块为召回块让位 |
| `injectMaxTokens` | 24000 | 注入总预算（token 口径，CJK 感知估算）。与字符口径双上限同时生效，取更严者。**0 = 关闭 token 预算** |
| `maxIndexLines` / `maxIndexChars` | 200 / 25000 | 项目索引截断预算 |
| `maxManifestFiles` | 200 | manifest 文件数上限 |
| `maxPromptChars` | 48000 | 增量 transcript 截断 |
| `maxOps` | 20 | 单轮最多写/删条数 |

token 估算是近似值（CJK 字 ≈1.5 token/字，其余 ≈0.25 token/字），不是精确分词。它是防挤爆上下文的护栏，不是精确计费。

## 提取触发

| 键 | 默认 | 说明 |
|---|---|---|
| `minUserWords` | 3 | skip 条件的散文词数下限 |
| `extractGateEnabled` | `true` | 打分门开关。`false` = 过薄轮次也照旧调模型 |
| `extractGateMinScore` | 6 | 打分门阈值：分数 = 用户词数 + 2×工具种类数 + 2×真人轮次数 |
| `extractIdleDelayMs` | 3000 | 空闲延迟（毫秒）。0 = 立即提取。超定时器上限会启动即抛 |
| `extractMaxRunsPerSession` | 50 | 每会话自动提取上限。0 = 不限。只约束自动链路 |

## 提取调用

| 键 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | 120000 | 单次提取调用超时 |
| `maxOutputTokens` | **0** | 提取输出上限。**0 = 跟随模型**（不发 `maxTokens`，由宿主套模型默认值，推荐）。显式 4096 会让带思考的模型把预算全花在思考上 |
| `extractReasoningEffort` | 不下发 | 思考档：`minimal` / `low` / `medium` / `high`（非法值启动即抛）。缺省不下发，跟模型默认档。**只在你路由确实声明了该档位时才配** |
| `retryAttempts` | 3 | 总 attempt 数（含首次） |
| `retryBackoffMs` / `retryMaxDelayMs` | 500 / 2000 | 指数退避首档与上限（jitter ±20%） |
| `fallback` | `[]` | 换道路由 `[{provider, model}]`，≤3 条、去重、不撞主道 |

关于 `maxOutputTokens`：设成固定值会让带思考的模型把预算耗在思考链上，正文返回空。实测 88 条 `llm-error` 里 81 条是 `kind=max-tokens`。留 0 跟随模型是最稳的。

关于 `extractReasoningEffort`：宿主会按模型能力声明校验档位，不被支持的档位在 provider I/O 前就被拒（`UNSUPPORTED_REASONING_EFFORT`），触发一次降级重发。所以配一个模型不支持的档位等于每轮白撞一次。

## 补提

| 键 | 默认 | 说明 |
|---|---|---|
| `autoRecoverEnabled` | `true` | 自动补提。会话关闭 / 轮次完成 / 启动清扫三个时机补未恢复的失败区间 |
| `autoRecoverCooldownMs` | 300000 | 同一区间两次自动补提的最小间隔（5 分钟） |

## 语义召回

| 键 | 默认 | 说明 |
|---|---|---|
| `recallEnabled` | `false` | 总开关。开启需配 `embeddingBaseUrl` + `embeddingModel` |
| `embeddingBaseUrl` | 空 | 嵌入端点，任意 OpenAI 兼容服务。`POST <url>`，体 `{model, input}`，返回 `{data:[{embedding}]}`。仅接受 `http(s)` |
| `embeddingModel` | 空 | 你的嵌入模型标识。它同时是向量空间的缓存身份——换模型 = 整库重嵌 |
| `embeddingApiKey` | 空 | 端点鉴权（可选） |
| `embeddingProvider` | 空 | 纯面板显示标签，不参与调用，不要求和 `embeddingModel` 成对 |
| `recallTopK` / `recallMaxTokens` | 5 / 1200 | 单轮召回条数 / 召回块 token 预算 |
| `recallMinScore` | 0.35 | 余弦相似度阈值（[0,1]，越界即抛） |
| `recallTimeoutMs` | 8000 | 单次嵌入调用超时。本地 CPU 嵌入独立调用约 0.6s，但宿主进程内竞争下可达数秒，故留足余量 |
| `recallTotalBudgetMs` | 20000 | 单轮召回整体时间预算。嵌入可能分批串行，单请求超时约束不住整轮耗时 |

配置不全时插件不启动失败，只是召回被显式关闭，面板出红条指路。详见[功能详解](features.md#语义召回可选默认关)。

## 近期动态

| 键 | 默认 | 说明 |
|---|---|---|
| `recentKeepCount` | 30 | 近期动态最多保留条数 |
| `recentKeepDays` | 30 | 近期动态最大年龄天数 |

## settings.json（面板可改）

这几项在 `~/.dsh/memory/settings.json`，宿主每轮读取，下一轮对话即生效。

| 键 | 默认 | 说明 |
|---|---|---|
| 对话记忆 / 项目记忆 / 全局自动提取 | 开 | 三层开关，面板「设置」页 |
| `runtimeEnabled` | `false` | 运行时记忆层开关 |
| `idleReviewEnabled` | `false` | 空闲整理开关 |
| `surgicalKeep` | 30 | 批前快照保留份数 |
| `trashKeepDays` | 30 | 回收站条目保留天数 |
| `recentKeepDays` | 30 | 近期动态保留天数（与 entry config 同名） |
| `hardfactPolicy` | `warn` | 硬事实丢失策略：`warn` 只告警；`block` 回滚该操作 |

手改取值规则（和面板 `PUT /settings` 同语义）：未提及的键保留现值；`surgicalKeep` / `trashKeepDays` 显式给非法值时按默认值生效；`hardfactPolicy` 给白名单外的值时保留现值。

`hardfactPolicy` 有意不给输入控件：拨到 `block` 会把合法更新一起回滚，用户会看到"我改的记忆自己变回去了"。改这个值需要手改文件。
