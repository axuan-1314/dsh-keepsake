# 贡献指南（CONTRIBUTING）

感谢关注 dsh-keepsake。本项目是一个**零运行时依赖**的 DSH 记忆插件，欢迎提交 issue 与 PR。

## 环境

- Node ≥ 18（与 `package.json` 的 `engines` 一致）。
- **零运行时依赖**：`clone` 下来无需 `npm install` 即可开发与测试。

## 跑测试

```bash
npm test        # node --test：全部单元测试（含防漂移检查 test/client-source.test.mjs）
npm run check   # lib/*.js 语法快检（跨平台，cmd / bash 均可跑）
```

提交 PR 前请确保 `npm test` 全部通过、`npm run check` 通过。

## 提交 PR 约定

- 一次 PR 聚焦一件事，改动尽量小而可读；在描述里说清「改了什么 / 为什么 / 怎么验证」。
- 改动行为时同步补/改对应测试——测试即行为契约。
- 触及用户可见行为、配置键、记忆文件格式或存储格式版本时，请同步更新 `README.md` / `README.en.md` / `FORMAT.md` / `CHANGELOG.md`（中英 README 保持信息对称）。
- 记忆文件格式（frontmatter / 索引行 / 文件命名）与存储格式版本是对外契约，变更需在 `FORMAT.md` 登记并说明影响。
- 保持零运行时依赖；确需引入依赖，请先在 issue 里说明理由。
- `test/` 下的用例不得依赖执行顺序或固定绝对路径——CI 在 Linux 与 Windows 上矩阵运行。

## 报告问题

- 走 GitHub Issues（地址见 `package.json` 的 `bugs`）。
- 请附：DSH 版本与 profile（web / headless / desktop）、插件版本、复现步骤、预期与实际表现。
- 管道类问题可先在设置页健康卡点「复制诊断信息」再粘贴（`extraction-errors.log` 只含错误摘要，不含会话内容）。
- **请勿在公开 issue 里粘贴真实记忆内容或 API Key**。

## 许可

贡献即表示同意以 [MIT License](LICENSE) 授权。
