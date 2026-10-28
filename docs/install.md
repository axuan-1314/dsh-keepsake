# 安装与升级

前置条件：已装 DSH（`web` / `headless` / `desktop` 任一 profile），Node ≥ 18。插件零运行时依赖，不需要 `npm install`。

## 安装

**从发布 tag 安装（推荐，版本固定）**

```bash
dsh plugin --profile web add "https://github.com/axuan-1314/dsh-keepsake/archive/refs/tags/v0.7.0.tar.gz"
```

可用的 tag 见 [Releases](https://github.com/axuan-1314/dsh-keepsake/tags)。`package.json` 里的版本号可能比最新 tag 高（已开发未打 tag），此时上面这个地址会 404——用下面的 `main` 渠道。

**跟主分支（含尚未打 tag 的开发内容）**

```bash
dsh plugin --profile web add "https://github.com/axuan-1314/dsh-keepsake/archive/refs/heads/main.tar.gz"
```

**本地克隆（改代码用）** —— 源码改动即时生效：

```bash
dsh plugin --profile web add "<克隆到本地的仓库路径>"
```

`--profile` 换成 `headless` 或 `desktop` 装到对应 profile。装完可以用 `dsh --profile web --dump-config` 确认 entry 已入树。

安装即启用：`cordis.patch.yml` 里显式写了 `enabled: true`（代码缺省是关，fail-closed）。

## 升级

DSH 插件管理器不支持自动更新，升级 = 用新版本重跑一次安装命令：

```bash
dsh plugin --profile web add "https://github.com/axuan-1314/dsh-keepsake/archive/refs/tags/v<新版本>.tar.gz"
```

本地克隆渠道 `git pull` 即可，不用重装。

**升级不影响数据**：记忆、开关、人设、备份全在 `~/.dsh/memory/`，在插件包目录之外，卸载重装都不碰它。

**升级后要重启**：替换包之后进程得重启才会加载新代码。`web` profile 由 HMR 自动重载；`desktop` 重启应用；`headless` 下次启动自然就是新的。

### 0.6.0 的行为变化

从 0.5.x 及更早升上来时注意四处变化：

1. 长期记忆（`global/long-term/`）不再进注入索引，归档条目对所有会话不可见（提取提示词里仍可见）；
2. 人设段上限 16000 → 8000 字符；
3. `injectMaxTokens` 默认 16000 → 24000；
4. 新增「运行时记忆」开关，默认关。不开的话注入内容和旧版基本等价，只少了长期记忆那几行索引。

### 降级

存储格式版本记在 `~/.dsh/memory/keepsake-format.json`，0.6.0 起是 `FORMAT_VERSION=2`。从 0.6.x 退到 0.5.0 或更旧时，旧版读到 v2 会**自动转只读**（写端点 503，读取照常），防止旧版覆写时把 `pinned` 标记剥掉。

0.4.0 / 0.5.0 退到 0.2.x 不会触发格式闸，可以正常读写，但会失去 0.4.0 的写入安全面（快照、回收站、sha1 覆盖闸、写后校验）。

降级前建议先做一次全量备份：面板设置页「导出全部」，或直接拷走整个 `~/.dsh/memory/`。

降级到 0.6.4 及更早的版本前，如果你在 `cordis.patch.yml` 里显式加过这两项，要先删掉：

- `extractReasoningEffort`（旧版不认识，属未知键）
- `maxOutputTokens: 0`（旧版要求正整数）

旧版 `resolveConfig` 遇到这两项会直接抛错，装载即失败。出厂配置里它们本来就是注释状态，只有你手动取消过注释才需要处理。

## 验证生效

1. 开个新会话，正常聊几轮有实质内容的话（整句散文，不是单词命令）。
2. 看落盘：`~/.dsh/memory/projects/<slug>-<hash16>/memory/` 下有没有出现 `MEMORY.md` 和条目文件，或 `~/.dsh/memory/global/work-profile/` 之类目录下有没有新条目。
3. 看注入：新开一轮，让模型复述"你记得关于我或这个项目的什么"，它引用得出记忆内容就是通了。
4. 直接查 API：`GET /dsh-keepsake/api/state`，看 `counts`（条目数）和 `extractionFailures`（应该全零）。
5. 打开 DSH 设置页 →「记忆」区块 →「打开记忆管理」，面板各页应能正常浏览。

## 回滚与卸载

**只停功能，不卸包**：把 profile 的 `cordis.patch.yml`（或 bundle patch）里 `enabled` 改成 `false`。`web` 靠 HMR 自动生效，`desktop` / `headless` 要重启。只想临时停用的话，用面板总开关更方便（下一轮对话就生效，不用重启）。

单项回退：

| 想回退什么 | 怎么做 |
|---|---|
| 注入通道 | `injectChannel` 改回 `"section"`（回 systemPrompt 注入，同样承载六段） |
| 运行时记忆层 | 面板关掉「运行时记忆」，或删 `settings.json` 里的 `runtimeEnabled`；`runtime/` 目录可整个删掉 |
| 语义召回 | `recallEnabled` 改 `false`，之后零嵌入调用 |

**整包卸载**：`dsh plugin --profile <name> remove dsh-keepsake`

**清数据**：删 `~/.dsh/memory/`。这是插件自有目录，不影响其他组件。

## 为什么数据放包外

DSH 插件不支持自动更新，升级必然要卸载重装。数据放在 `~/.dsh/memory/` 而不是包目录里，卸载重装就天然不影响用户数据。这个分离是刻意的，不是巧合。
