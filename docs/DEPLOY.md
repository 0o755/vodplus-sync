# 部署与发布

本项目部署为单个 Worker，静态资源随代码一起发布。D1 和 R2 是必需绑定，不使用 WebSocket 或 Durable Objects。

## 官方一键部署

Cloudflare 的 Deploy 按钮会复制公开 GitHub/GitLab 仓库，创建资源，并通过 Workers Builds 构建部署。需要登录自己的 Cloudflare/GitHub 账户、授权仓库访问，并在账户中启用 R2；这不是无需账户的匿名部署。

直接部署可点击 [本仓库的官方部署入口](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2F0o755%2Fvodplus-sync)，然后从下面第 4 步继续。维护自己的 Fork 时，先完成第 1–3 步。

1. 创建自己的公开 GitHub 仓库或 Fork。原仓库尚未指定开源许可证，修改分发前应先明确授权。
2. 运行 `node scripts/release-link.mjs https://github.com/OWNER/REPOSITORY`。它仅把 README 的预留区域替换为真实仓库的官方按钮。
3. 提交源码、`package-lock.json`、迁移、Wrangler 配置和 `.dev.vars.example`。不要提交 `.dev.vars`、`.env`、`.wrangler`、任何用户导出或测试凭证。
4. 点击 README 按钮。页面将识别 `wrangler.jsonc` 的 DB、BUCKET 绑定及 `.dev.vars.example` 声明的 `BOOTSTRAP_SECRET`。
5. 为初始化密钥填写独立随机值，至少 32 位。不要沿用测试服务中的 fixture 值。
6. 保留检测到的构建命令 `npm run build` 与部署命令 `npm run deploy`。部署脚本先以 **DB 绑定名**执行远端迁移，再发布 Worker。
7. 首次打开 Worker URL，填写初始化密钥、管理员名和至少 12 位密码。初始化只能成功一次；之后可从 Cloudflare Secrets 删除 `BOOTSTRAP_SECRET`。

`web/deploy.html` 还提供仓库地址输入入口：校验 GitHub 地址后生成官方 Deploy 链接。它不读取 Cloudflare 凭证、不代替官方授权页。

Wrangler 配置省略 `database_id`，供 Deploy 流程自动创建并绑定 D1；R2 使用可被模板流程重命名的默认 bucket 名。Deploy 模板流程负责资源预配置，运行迁移时资源必须已经存在。**不要将下面的本地 CLI 部署流程与模板预配置混淆。**

## 已有仓库的手动部署

先运行 `npm ci --ignore-scripts`，使用 Wrangler 登录 Cloudflare。首次 CLI 部署时先创建资源：

```text
npx wrangler login
npx wrangler d1 create vodplus-sync
npx wrangler r2 bucket create vodplus-sync-files
```

把 D1 返回的 `database_id` 写入 `wrangler.jsonc` 对应 DB 项；如资源名被占用，调整 D1 名称与 R2 bucket 名。然后：

```text
npx wrangler secret put BOOTSTRAP_SECRET
npm run deploy
```

首次 secret 操作可能提示先建立 Worker，可按 Wrangler 提示建立空 Worker；也可以先执行 `npx wrangler deploy` 完成资源绑定，再设置 Secret，最后 `npm run deploy` 执行迁移。未迁移时 API 会显示服务未就绪，且没有公开注册绕过入口。

上述命令供使用者在自己的终端执行；本次开发没有调用 Windows cmd、PowerShell，也没有实际运行远端部署命令。

## 本地开发

`.dev.vars` 只存本地初始化密钥。`npm run db:local` 在 `.wrangler` 建立本地 D1；R2 由 Wrangler 本地模拟器提供。`npm run dev` 打开本地 Worker。每次增加迁移后重新执行本地迁移。

测试使用独立内存 workerd/D1/R2，不会读取或改变本地开发数据库。临时预览脚本也是内存实例，退出即销毁。预览的固定测试账号只存在于该脚本中，生产 Worker 不导入该脚本。

## 升级与维护

- 保留既有 D1 ID 和 R2 名称，不要为升级换新资源。
- 新增迁移文件，禁止修改已经在线应用的历史迁移。当前 `0001_initial.sql` 是首次发布基线。
- `npm run deploy` 会先应用未执行迁移，失败则停止发布。涉及删除列等破坏性迁移前，应先导出 D1 并备份相关 R2 对象。
- 每天 03:17 UTC 清理过期会话、绑定码、分享凭证、限速记录以及 30 天前的操作日志。
- 自动清理不触及文件、回执、墓碑和增量日志。监控 D1/R2 用量；目前不支持无人值守的历史内容回收。
- Worker 默认关闭请求日志采集，避免含分享凭证的 URL 进入应用日志。若启用外部代理或可观测性，请自行脱敏 URL 查询参数。

## 已核验的官方依据

截至 2026-11-15，已读取官方 [Deploy 按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/) 和 [Wrangler 资源自动配置说明](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)。前者明确说明资源预配置、`.dev.vars.example` Secret 声明、package.json 的构建/部署命令和按绑定名执行 D1 迁移。

本地已通过配置 dry-run 和迁移集成测试；公开仓库为 [0o755/vodplus-sync](https://github.com/0o755/vodplus-sync)。**尚未授权真实 Cloudflare 账户或执行官方按钮的线上端到端部署**。
