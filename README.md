# CLIProxyAPI 数据看板

基于 Next.js App Router + Drizzle + Vercel Postgres 的数据看板，用于拉取上游 CLIProxyAPI 的使用数据，持久化到数据库，并进行数据可视化。

## 功能
- /api/sync 拉取 usage 并去重入库（支持 GET/POST，便于外部 Cron 或 CF Worker 调用）
- /api/overview?days&model&route&page 汇总请求/Token/费用，支持时间范围、模型、Key 筛选
- /api/prices 读取/保存模型单价，前端表单可配置
- 前端图表：日粒度折线图、小时负载柱状图、模型费用列表，可切换最近 7/14/30 天


## 部署到 Vercel
1. Fork 本仓库，创建 Vercel 项目并关联
2. 在 Vercel 环境变量中填写：
  - CLIPROXY_SECRET_KEY (即登录后台管理界面的管理密钥)
  - CLIPROXY_API_BASE_URL (即自部署的 CLIProxyAPI 根地址)
  - DATABASE_URL (仅支持 Postgres)
3. 部署后，可通过以下方式自动同步上游使用数据：
	- Vercel Cron（Pro 可设每小时，Hobby 每日一次）：调用 GET `/api/sync`
	- CF Worker / 其他定时器定期请求上述路径

## 自动同步上游
- Vercel Cron 表达式（Pro 可设每小时，Hobby 每日一次）：`0 * * * *` → GET `https://your-domain.vercel.app/api/sync`
- Cloudflare Worker 完整示例：可见 `cf-worker-sync.js`

## 本地开发步骤
1. 安装依赖：`pnpm install`
2. 复制环境变量：`cp .env.example .env`
3. 创建表结构：`pnpm run db:push`
4. 同步数据：GET/POST `/api/sync`
5. 启动开发：`pnpm dev`
