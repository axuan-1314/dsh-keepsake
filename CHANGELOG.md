# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，变更记录格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

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

[未发布]: https://github.com/axuan-1314/dsh-keepsake/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.3.0
[0.2.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.2.0
[0.1.0]: https://github.com/axuan-1314/dsh-keepsake/releases/tag/v0.1.0
