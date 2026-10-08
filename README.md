# dsh-memory

DSH（DeepSeek Harness）0.2.0-rc.2 cordis 插件：**项目记忆自动提取 + 注入**。移植自 ZCode 项目记忆子系统（T2 规格），v1 采用单次 LLM 调用简化提取。

## 功能

- **触发**：订阅 `session/event`，在 `turn/end`（`data.reason.kind === "completed"`）后触发提取（进程内单飞 + latestPending 合并）。
- **提取**：`ctx.llm.stream` 单次调用——输入为增量 transcript 摘录 + 现有记忆 manifest（mtime 降序前 200，最近小文件附正文），输出为 `Nothing to save.` 或一个 `{"ops":[...]}` JSON。
- **落盘**：由插件（非模型）写文件到 `~/.dsh/memory/projects/<slug>-<hash16>/memory/`，文件名经三道闸（包含性判定 + 黑名单段 + Unicode 控制符剥除）；`MEMORY.md` 索引自动合并维护。
- **注入**：`ctx.systemPrompt.section` 注入四段——4990 人设（称呼指令+补充设定）、4995 全局记忆索引（每类 40 行 / 总 120 行预算）、5000 项目使用说明、5001 项目 MEMORY.md 索引（200 行 / 25k 字符截断，保最新丢最旧 + WARNING）。
- **skip 双条件**：无 ≥3 词用户散文；本轮已有对记忆目录的直写（write/edit 工具落 memoryRoot）。

## 数据布局

```
~/.dsh/memory/projects/<slug>-<hash16>/memory/
├── MEMORY.md          # 索引：- [Title](file.md) — 一行钩子（≤150 字符）
└── <kebab-name>.md    # 记忆文件：frontmatter name/description/metadata.type
```

- `slug`：workspace basename 净化（小写、`[^a-z0-9._-]+`→`-`、截 48、空则 `project`）
- `hash16`：绝对路径（win32 转小写）sha256 前 16 hex

## 配置（cordis entry config，见 cordis.patch.yml）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | **false（代码缺省关，fail-closed）** | 总开关；`cordis.patch.yml` 显式 `enabled: true`，安装即启用且开关可见于 YAML |
| `storageRoot` | `~/.dsh/memory` | 记忆总根（测试/迁移用，一般不动） |
| `provider` / `model` | 空（跟随会话路由） | 提取调用的模型路由；成对出现，否则报错。缺省时自动捕获本会话 `request/header` 的路由（同 session-title 策略） |
| `minUserWords` | 3 | skip 条件的散文词数下限 |
| `timeoutMs` | 120000 | 单次提取调用超时 |
| `maxOutputTokens` | 4096 | 提取输出上限 |
| `maxIndexLines` / `maxIndexChars` | 200 / 25000 | 注入截断预算 |
| `maxManifestFiles` | 200 | manifest 文件数上限 |
| `maxPromptChars` | 48000 | 增量 transcript 截断 |
| `maxOps` | 20 | 单轮最多写/删条数 |

## 回滚

1. **停功能不卸包**：把 profile 的 `cordis.patch.yml`（或 bundle patch）里 `enabled` 改为 `false`。生效方式分 profile：**web profile 由 HMR 自动生效；desktop/headless 改 config 后需重启对应实例**（桌面端重启应用；headless 本就每次启动新进程）。不存在"改完即热生效"的统一行为，以上为各 profile 的实际生效路径。
2. **整包卸载**：`dsh plugin --profile <name> remove dsh-memory`。
3. **清数据**：删 `~/.dsh/memory/`（自有目录，不影响其他组件）。

## 安装

```bash
dsh plugin --profile web add D:\dsh-keepsake       # 或 headless / desktop
dsh --profile web --dump-config                  # 验证 entry 入树
```

三个 profile 的安装均为 **symlink（link:D:\dsh-keepsake）**，源码改动无需同步拷贝；但运行中的 desktop 实例吃到新代码需 HMR 重载或重启应用（headless 每次启动天然取最新）。

## 测试

```bash
npm test    # node --test，198 项断言（含防漂移检查 test/client-source.test.mjs）
```

## 可观测与运维

- **提取失败计数**：`/dsh-memory/api/state` 的 `extractionFailures`（按原因分桶 + 同因连击 streak）；门牌/面板红条显示连续失败。结构性失败（无路由/无 cwd）连续 5 次后显式放弃该区间（error 日志），不再无限重试积压。
- **损坏可见**：settings.json / addressing.json / persona.md 解析失败=按缺省运行 + `corrupt` 标记 + 界面红条；覆盖写前损坏档自动备份 `*.corrupt-<ts>`。
- **debug 日志口**：`DSH_MEMORY_DEBUG=1` 时写 `<storageRoot>/debug.log`（>1MB 轮转两档 debug.log.1）——Electron 宿主 console 不回传时的唯一可见通道。
- **备份策略**：reset/import/restore 前自动全量备份到 `backups/`，滚动保留最新 **20 份**；半备份（meta 无 complete）标记 incomplete 且拒绝恢复。
- **逐项检查脚本**：`tools/m1-api-walkthrough.sh` 会清空目标宿主的记忆数据——默认拒绝执行，须显式 `WALKTHROUGH_CONFIRM=yes`（只对一次性验收容器跑）。

## 已知限制

- **规格 taskType 过滤未移植**：ZCode 侧按任务类型（interactive/fork/…）过滤提取资格；本插件对所有会话生效，依赖 skip 双门槛（无 ≥3 词散文 / 直写轮）兜底抑制噪声。
- **相对路径 file_path 的直写判定偏保守**：`transcript.js` 对 write/edit 的 `file_path` 以 memoryRoot 为基解析相对路径，恰好落在记忆目录内的相对路径会判为"直写轮"而 skip 提取——方向保守（多 skip、不漏存），安全。
- **单次 LLM 调用**（非 ZCode 的提取子任务 loop，其 API 面在 DSH 未实证）：更新老记忆时模型只见 manifest 描述 + 最近小文件正文，不见全部旧文；由 manifest 附正文（≤3000 字符 × 最近 10 文件）缓解。
- **防自反馈与检索**：提取调用为 request-only 输入、不向任何 session append 事件；记忆正文无自动检索，靠模型按索引主动 Read（与 ZCode 同构）。
- **desktop/headless 改 config 需重启实例**（见回滚节），无统一热生效。
- **单条覆盖写无编辑历史**（全面审查 P3-12 有意不修）：PUT persona / PUT entry 直接替换旧文——粘贴错内容保存即丢旧文；批量破坏路径（reset/import/restore）有自动备份，单条覆盖请自行先导出兜底。
- **4995 全局索引每次求值全量读条目**（有意不修）：近期动态条目渲染读取条目正文（只用 40 行预算），桌面规模无感；若条目数暴涨可加 mtime 缓存。
