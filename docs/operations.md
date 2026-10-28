# 运维与 API

## 观测面

所有观测数据从 `GET /dsh-keepsake/api/state` 取，面板设置页的「管道健康卡」消费同一份。

### 提取状态

`extractionFailures` —— 按原因分桶 + 同因连击数 `streak` + `retried` 重试计数 + `recent[5]` 最近失败详情 + `reasoningDegraded` 思考档降级次数。

`extractionTokens` —— `{input, output, total, calls}`，进程内累计。`calls` 记真实发起的调用次数（含降档重发那一趟、含失败途）；`total` 取宿主上报的 `totalTokens`。宿主没发 usage chunk 时 token 记 0 但 `calls` 仍计数——"调了几次"和"花了多少 token"分开报。

其它字段：`lastFailedRange`（未恢复的失败区间）、`extractionInFlight`、`lastAttemptAt`、`lastUsedRoute`（最近一次提取用车）、`extractionConfig`。

### 提取运行日志

`extractionLog` —— 数据源是 `<storageRoot>/extraction-journal.jsonl`。

| 字段 | 内容 |
|---|---|
| `runs` | 最近 30 条结算记录 |
| `unrecovered` | 失败且未被后续补上的区间 |
| `abandoned` / `abandonedCount` | 结构性失败被显式放弃、不再重试的区间 |
| `coverage` | 区间口径的覆盖率，见下 |

每次结算追加一行：`written`（写/删了几条）/ `zero-ops`（无可记）/ `skipped`（多种原因）/ `failed` / `abandoned`。行数超 2000 自动轮转留尾 1000。写日志失败只告警，不阻断提取。

`coverage` 是判断"修复真的生效"的唯一判据：

```
distinctFailedRanges / distinctWrittenRanges / distinctAbandonedRanges
writtenRangeRate = written / (written + failed + abandoned)
```

**区间口径，不是轮次口径**（宿主不提供总轮次数，不编造）。修复生效后"不再反复白撞同一区间"会让 `failed` 计数下降，但那不等于记忆变多——只有 distinct `(sessionId, from, to)` 区间数说得清。

每个区间只归一种终态（written > abandoned > failed，强终态覆盖弱终态）。先失败后被补提救回的区间只算成功，不会同时计入失败。

### 其它观测字段

| 字段 | 内容 |
|---|---|
| `injection` | `count` / `lastChars` / `totalChars` / `resends` / `droppedSegments` / `compactedSegments` / `renderFailures` / `throttled` / `superseded` / `lastTokens` / `totalTokens` |
| `recall` | `hits` / `items` / `chars` / `misses` / `errors` / `lastAt` |
| `safety` | 盘上三项实时现算（`surgicalBackups` / `lastSnapshotAt` / `trashPending`）+ 进程内七项计数（`verifyFailed` / `hardfactDrops` / `hardfactBlocks` / `expectedSha1Mismatches` / `blindWriteDowngrades` / `lockConflicts` / `snapshotFailures`）。进程内计数重启清零 |
| `recover` | `inFlight` / `lastAt` / `lastOutcome` / `lastSessionId` / `autoEnabled` / `autoAttempts` / `lastAutoAt` / `lastAutoTrigger` |
| `pages` | `generations` / `errors` / `lastAt` / `lastError` / `lastScope` / `lastChars` |
| `idleReview` | `runs` / `written` / `deletes` / `skipped` / `errors` / `lastAt` / `lastOutcome` / `rejected` |
| `corrections` | `runs` / `applied` / `writes` / `deletes` / `failed` / `lastAt` / `lastOutcome` / `lastTarget` / `lastReason` / `recent[20]` |
| `settingsDiagnostics.coercedFields` | 被纠正回默认值的设置字段名 |

## REST 端点

全部端点先过 loopback 守卫（仅 127.0.0.1 / localhost，校验 Host 与 Origin）。无 webserver 的 profile 不挂载这些端点。

### 状态与提取

| 端点 | 说明 |
|---|---|
| `GET /api/state` | 全部观测数据 |
| `POST /api/extract/retry` | 立即重试提取。202 已触发；在途 409；10 秒最小间隔 |

### 记忆条目

面板的增删改查走 `/api/entry` 系列，面板内部使用。手动保存覆盖前会先留快照。

### 检索

| 端点 | 说明 |
|---|---|
| `GET /api/search?q=&projectId=&limit=` | 关键词检索。`q` 空返回 400，不退化成"返回全部" |
| `GET /api/search/list?projectId=&limit=` | 按 mtime 倒序列出。`truncated` 如实回报 |

### 会话补提

| 端点 | 说明 |
|---|---|
| `GET /api/sessions/pending` | `hostSupported` + `items[]`（每条带 `sessionId` / `from` / `to` / `at` / `reason` / `kind` / `sessionAvailable`） |
| `POST /api/sessions/recover` | 202 异步；409 单飞；404 会话不在；503 宿主未提供会话持久化 |

### 整理

| 端点 | 说明 |
|---|---|
| `GET /api/maintenance/suggestions` | `duplicates` / `stale` / `indexHealth` / `counts` / `generatedAt` |
| `POST /api/maintenance/repair-index` | `fixed`（动作明细数组）/ `fixedCount` / `unchanged` |

### 纠错

| 端点 | 说明 |
|---|---|
| `POST /api/corrections/correct` | body `{target, reason, kind?, scope?, projectId?}`。`outcome` ∈ `applied` / `needs-input` / `nothing`。400 参数不全；409 开关关或并发；503 无路由；422 操作全被闸拦下；502 其余 |
| `POST /api/corrections/correct-batch` | body `{items:[...], sessionId?}`，上限 10 条，超限 400 `E_TOO_MANY` 且一次调用都不发。`outcome` ∈ `applied` / `partial` / `error`，逐条结局在 `results[]` |
| `GET /api/corrections/recent?limit=` | `entries` + `state` 快照 |
| `GET /api/corrections/by-target?target=&scope=&maxGroups=` | `groups[]` 每项含 `target` / `scope` / `count` / `writes` / `deletes` / `verifyFailed` / `lastAt` / `kinds[]` / `rows[]` |

### 运行时记忆

| 端点 | 说明 |
|---|---|
| `GET /api/runtime/<scope>` | `scope` = `global` 或 `projects/<slug>-<hash16>`。返回产物文本 / 字节 / 配额 / `status` / 淘汰候选。不存在 404 |
| `POST /api/runtime/<scope>/compile` | 重新编译 |
| `POST /api/runtime/compile-all` | 全量重编 |
| `POST /api/runtime/<scope>/pin` | 切换 `pinned` |
| `POST /api/runtime/<scope>/evict` | 执行淘汰归档。锁被占 409 |
| `POST /api/runtime/global/archive/restore` | 从归档移回 |

### 知识页

| 端点 | 说明 |
|---|---|
| `GET /api/pages/read?projectId=` | `available=false` 表示未生成。返回 manifest + 五页正文 |
| `POST /api/pages/generate` | body `{projectId}`，同步一次 LLM 调用。非法 id 400；开关关或并发 409；无路由 503；解析或调用失败 502；落盘失败 500 |

### 轮次活动

| 端点 | 说明 |
|---|---|
| `GET /api/turn-activity?sessionId=&sinceMs=&untilMs=&limit=` | `{events, total, truncated, window, sessionId}`。`window` 只在 provider 真被调用时出现——它是"接线活着"的判据 |

## 日志文件

| 文件 | 内容 |
|---|---|
| `extraction-errors.log` | 每次提取失败追加一行。只记摘要（时间 / pid / 原因 / 路由 / 错误摘要），**不含会话内容**。常开，超 512KB 轮转两档 |
| `extraction-journal.jsonl` | 提取结算日志（观测 + 续提边界）。超 2000 行轮转留尾 1000 |
| `correction-ledger.jsonl` | 纠错审计。1000 行轮转留尾 500 |
| `evict-audit.jsonl` | 淘汰归档审计。5000 行轮转留尾 2500 |
| `runtime/compile-journal.jsonl` | 运行时编译日志 |
| `debug.log` | 仅在 `DSH_KEEPSAKE_DEBUG=1` 时开启，>1MB 轮转两档。Electron 宿主 console 不回传时的全量诊断通道 |

## 排障

**改了配置怎么没生效？**
分两层。`cordis.patch.yml` 里的 entry config 改完，`web` 走 HMR 自动生效，`desktop` / `headless` 要重启。面板里的三层开关、称呼、人设写在 `settings.json`，下一轮对话即生效，不受重启限制。

**设置页红条「自动提取失败 N 次」怎么办？**
典型场景是免费池限流 429。健康卡灯变红、显示连击数、失败分桶、最近失败详情、错过区间提示。插件会自动重试并在此后每轮自动补提。长期不恢复就到健康卡点「立即重试提取」，或看 `extraction-errors.log`，或在 `cordis.patch.yml` 给插件显式配一组更稳的 `provider` / `model`。

**手动编辑条目保存错了能找回吗？**
看情况：

- **保存全局条目**（含编辑与新增改名）有留档。成功响应带 `preSaveSnapshotId`，「快照」页可找回被顶掉的旧文。
- **保存人设、改称呼**没有留档，直接替换（仅损坏档覆盖前会备份）。改之前请自行导出兜底。
- **删除条目**进回收站，默认保留 30 天，可在「回收站」页找回。

自动提取产生的覆写和删除同样走快照与回收站。项目记忆不在面板手工编辑。

**刚聊的事为什么没被记下来？**
依次排查：

1. 该轮没有 ≥3 个词的用户散文（比如只有单词命令）会被 skip——这是降噪设计；
2. 你或模型在该轮直接写入了记忆目录，直写轮会跳过自动提取；
3. 提取失败（看红条或健康卡）；
4. 三层开关被关了。

任何情况都可以在面板手动新增条目补上。

**我的对话内容会被上传到哪？**
记忆数据全在本地 `~/.dsh/memory/`。提取调用走你当前会话的模型路由（和你对话是同一条通道，发给它的是增量对话摘录加现有记忆索引）。失败日志只记错误摘要，不含会话内容。API 和面板只监听 loopback。

**「立即重试提取」提示间隔过短？**
按钮有 10 秒最小间隔（进程内计时，重启插件会重置）。提取在途时返回 409。稍候再点。

**面板打不开？**
先确认 DSH 设置页里插件开关是开的，且当前 profile 挂了 webserver（无 webserver 的 profile 不挂载面板）。门牌新窗口失败会自动降级（新窗口 → 内嵌 iframe → 整页跳转）。也可以直接访问 `http://127.0.0.1:<端口>/dsh-keepsake/panel/`——端口看 DSH 设置或启动日志。

**开了语义召回但从不命中？**
1. 设置页「嵌入服务」卡点「测试连接」，确认端点可达、模型名正确（成功会回显向量维度）；
2. 看 `/state.recall` 的 `hits` / `misses` / `errors`；
3. `recallMinScore`（默认 0.35）太高会滤掉本该命中的条目，可适当下调。

另注意召回受三层开关管辖：关掉总开关即零注入、零外联。

## API 冒烟

`tools/api-walkthrough.sh` 对一次性测试实例把全部 REST 端点走一遍。默认拒绝执行，须显式 `WALKTHROUGH_CONFIRM=yes`；**它会清空目标实例的记忆数据**，别指向正在用的实例。
