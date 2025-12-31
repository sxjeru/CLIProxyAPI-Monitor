# CLIProxyAPI 数据看板

基于 Next.js App Router + Drizzle + Vercel Postgres 的数据看板，用于拉取上游 CLIProxyAPI 的使用数据，**持久化到数据库**，并进行数据可视化。

## 功能
- `/api/sync` 拉取上游用量数据并去重入库（支持 GET/POST，需鉴权）
- 前端表单可配置模型单价
- 前端图表：日粒度折线图、小时粒度柱状图、模型费用列表，支持时间范围、模型、Key 筛选
- 访问密码保护

## 部署到 Vercel
1. Fork 本仓库，创建 Vercel 项目并关联
2. 在 Vercel 环境变量中填写：

	| 环境变量 | 说明 | 备注 |
	|---|---|---|
	| CLIPROXY_SECRET_KEY | 登录 CLIProxyAPI 后台管理界面的密钥 | 无 |
	| CLIPROXY_API_BASE_URL | 自部署的 CLIProxyAPI 根地址 | 如 `https://your-domain.com/` |
	| DATABASE_URL | 数据库连接串（仅支持 Postgres） | 亦可直接使用 Vercel Neon |
	| PASSWORD | 访问密码，同时用于调用 `/api/sync` | 可选；默认使用 `CLIPROXY_SECRET_KEY` |
	| CRON_SECRET | 使用 Vercel Cron 时需填写 | 任意字符串即可；建议长度 ≥ 16 |

3. 部署后，可通过以下方式自动同步上游使用数据：

	- Vercel Cron（Pro 可设每小时，Hobby 每天同步一次）：调用 GET `/api/sync` 并携带 `Authorization`
	- Cloudflare Worker / 其他定时器定期请求同步：可见 [cf-worker-sync.js](https://github.com/sxjeru/CLIProxyAPI-Monitor/blob/main/cf-worker-sync.js)

## 预览

|   |   |
| --- | --- |
| <img width="2186" height="1114" alt="image" src="https://github.com/user-attachments/assets/939424fb-1caa-4e80-a9a8-921d1770eb9f" /> | <img width="2112" height="1117" alt="image" src="https://github.com/user-attachments/assets/e5338679-7808-4f37-9753-41b559a3cee6" /> |
<img width="2518" height="1055" alt="image" src="https://github.com/user-attachments/assets/35d020f8-e398-44d1-b661-6f4b84cbaa20" />


## DEV
1. 安装依赖：`pnpm install`
2. 复制环境变量：`cp .env.example .env`
3. 创建表结构：`pnpm run db:push`
4. 同步数据：GET/POST `/api/sync`
5. 启动开发：`pnpm dev`
