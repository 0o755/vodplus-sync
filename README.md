# VodPlus Sync

运行在 Cloudflare Workers 上的爬虫管理与人物数据同步平台。用一个简洁后台管理家人的本地资源、观看记录、设备和带密码的配置接口。

- **人物隔离**：后台预建用户，一次性绑定设备。观看历史、进度、搜索和配置分别归属各人物。
- **文件管理**：目录树、上传、编辑、移动、重命名、停用、回收站、版本恢复与冲突处理。
- **按变化同步**：完整文件上传，SHA-256 校验，版本比较、幂等回执和游标增量；无长连接。
- **只读分享**：选择目录并设置密码，生成点播、多线路与直播配置，脚本和嵌套配置同样需要授权。
- **公共爬虫库**：可独立发布，也可显式复制给用户；复制后各自维护。
- **轻量部署**：Workers 提供接口和静态后台，D1 同时保存元数据和文件内容；没有常驻应用服务器。

## 开始使用

需要 Node.js 22+（本地开发时）和 Cloudflare 免费账户。**无需 R2，无需为本项目填写 R2 支付资料。**

```text
npm ci --ignore-scripts
npm run db:local
npm run dev
```

先将 `.dev.vars.example` 复制为 `.dev.vars`，为 `BOOTSTRAP_SECRET` 填入至少 32 位随机值。打开开发服务后，用该密钥创建管理员，管理员密码至少 12 位。**没有内置默认管理员或默认口令。**

登录后：创建人物 → 生成绑定码 → 上传资源 → 按需发布带密码的接口。后台现已可独立管理资源；ys 的设备同步需要按 [App 接入](docs/APP_INTEGRATION.md) 实现客户端适配。

## 部署到 Cloudflare

仓库发布后可使用 Cloudflare 官方 Deploy 按钮，创建 Worker，并自动复用或创建 D1、执行迁移。具体要求见 [部署说明](docs/DEPLOY.md)。

<!-- deploy-button:start -->
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2F0o755%2Fvodplus-sync)
<!-- deploy-button:end -->

源码仓库：[0o755/vodplus-sync](https://github.com/0o755/vodplus-sync)。点击按钮后在自己的 Cloudflare 账户中确认资源并设置初始化密钥；仓库不会代为开通付费资源。

## 文档

| 文档 | 内容 |
|---|---|
| [部署](docs/DEPLOY.md) | Deploy 按钮、资源初始化、Secrets、本地开发与升级 |
| [使用](docs/USAGE.md) | 用户、设备、文件、公共库和配置分享 |
| [架构](docs/ARCHITECTURE.md) | 权限、事务、冲突、存储生命周期与当前边界 |
| [同步协议](docs/PROTOCOL.md) | 绑定、上传、提交、游标、记录身份与错误处理 |
| [App 接入](docs/APP_INTEGRATION.md) | ys 接入点、队列隔离、原子落盘、扫描停用与日志 |
| [参考客户端](examples/sync-client.js) | 可测试的传输实现及宿主适配器边界 |
| [验证记录](docs/VALIDATION.md) | 本地集成测试与浏览器验收范围 |

## 项目结构

```text
src/             Worker 路由、认证、同步与分享模块
web/             无框架管理界面与独立页面模块
migrations/      D1 有序迁移
examples/        App 协议参考实现
tests/           workerd + D1 集成测试与部署流程回归
scripts/         检查、部署、临时预览和发布准备
docs/            运维、使用与接入文档
```

## 验证

```text
npm run check
npm test
npm run build
```

`build` 仅 dry-run 打包，不创建线上资源。GitHub Actions 在推送和 PR 时执行同样检查。`node scripts/preview.mjs` 为本地界面验收创建可丢弃的内存数据，仅监听 `127.0.0.1:8799`；它不是部署入口。

当前定位是家庭或小范围使用的第一版。单文件上限 1.5 MiB，每个空间最多 5000 条实体（包括删除记录），目录单次批量操作最多 80 项。历史浏览显示最近 20 版；为长期离线设备保留增量记录和内容，暂不自动清理历史内容。免费 D1 单库上限为 500 MB，包含文件、历史、元数据和索引；文件内容采用 Base64 小块存储，有约 1/3 编码开销。详细容量边界见架构文档。

尚未选择开源许可证；公开 GitHub 仓库前请由仓库所有者确定授权方式。
