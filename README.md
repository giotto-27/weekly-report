# 周报看板迁移版

这是从本地备份重建的项目。网页保留两排等宽的人员按钮、2025 年到 2026 年的周次归属和月度计划合并处理。现有周报快照更新于北京时间 2026-10-11 17:52。

## 放入新的 GitHub 仓库

1. 在目标账号下创建空仓库，建议命名为 weekly-report，默认分支为 main。将压缩包解压后，把里面的目录和文件完整放入仓库根目录，包括 .github 目录。
2. 在启用 Pages 前确认周报正文和考勤可以公开。GitHub Free 的 Pages 需要公开仓库，访客也能直接访问 data/data.json。
3. 在 Settings → Pages 将 Source 设为 GitHub Actions。
4. 先在 Actions → 手动同步或发布周报 → Run workflow 只勾选发布当前网页。这样会发布包里的快照，无需腾讯文档 Token。
5. 更新数据前先停用原来的外部定时触发。在 Settings → Secrets and variables → Actions 添加 TENCENT_DOCS_TOKEN。Token 由有权限的人员通过 GitHub 直接录入。
6. 手动同步时在工作流中勾选确认读取腾讯文档。数据变化时会更新并发布。修改页面后可以单独勾选发布。

同步出错时会保留已有数据。同步工作流仅支持手动触发。周报的文件编号、表格列范围和最早周次年份位于 config.json。

本地测试使用 Node.js 22 或更高版本，在项目目录运行 node --test tests/*.test.mjs。
