# CLIProxyAPI 数据看板

基于 Next.js App Router + Drizzle + Postgres 的数据看板，用于自动拉取上游 CLIProxyAPI 使用数据，**持久化到数据库**，并进行数据可视化。

## 功能
- `/api/sync` 拉取上游用量数据并去重入库（支持 GET/POST，有鉴权）
- 前端表单可配置模型单价，亦支持从 models.dev 自动拉取价格信息（ [#17 @ZIC143](https://github.com/sxjeru/CLIProxyAPI-Monitor/pull/17) ）
- 前端图表：日粒度折线图、小时粒度柱状图、模型费用列表等，支持时间范围、模型、Key、凭证筛选
- 访问密码保护

## 部署到 Vercel
1. Fork 本仓库，创建 Vercel 项目并关联
2. 在 Vercel 环境变量中填写：

	| 环境变量 | 说明 | 备注 |
	|---|---|---|
	| CLIPROXY_SECRET_KEY | 登录 CLIProxyAPI 后台管理界面的密钥 | 无 |
	| CLIPROXY_API_BASE_URL | 自部署的 CLIProxyAPI 根地址 | 如 `https://your-domain.com/` |
	| DATABASE_URL | 数据库连接串（仅支持 Postgres） | 可直接使用 Neon |
	| DATABASE_DRIVER | `pg` 或 `neon` | 可选；默认自动检测 |
	| DATABASE_CA | DB 服务端 CA 证书 | 可选；PEM 原始内容或 Base64 编码均可 |
	| PASSWORD | 访问密码，同时用于调用 `/api/sync` | 可选；留空默认使用 `CLIPROXY_SECRET_KEY` |
	| CRON_SECRET | 使用 Vercel Cron 时需填写 | 任意字符串均可；建议长度 ≥ 16 |

3. 部署后，可通过以下方式自动同步上游使用数据：

	- 默认启用 Vercel Cron（ Pro 可设每小时，Hobby 每天同步一次，请见 [vercel.json](https://github.com/sxjeru/CLIProxyAPI-Monitor/blob/main/vercel.json) ）
	- Cloudflare Worker / 其他定时器定期请求同步：可见 [cf-worker-sync.js](https://github.com/sxjeru/CLIProxyAPI-Monitor/blob/main/cf-worker-sync.js)

## Docker部署

| compose file service | migrate-DB                                                         | app               |
| -------------------- | ------------------------------------------------------------------ | ----------------- |
| =                    | 用来初始化数据库, 建表啊之类的(先启动, 看到DB里面有表了就可以删了) | 服务端app(后启动) |

- 参考[docker-compose.yml](./docker-compose.yml)文件来进行docker的部署
- 为什么用两个镜像. 因为同时打包的话太大了, 反正数据库也不是会频繁变结构的

| IMAGE                              | DISK USAGE | CONTENT SIZE |
| ---------------------------------- | ---------- | ------------ |
| cliproxyapi-monitor:latest         | 331MB      | 80.3MB       |
| cliproxyapi-monitor-migrate:latest | 580MB      | 96.6MB       |

- 运行完migrate-DB, 会有类似log
```log
检查迁移表... (驱动: pg)
执行数据库迁移...
✓ 迁移完成
```

- app的log
```log
▲ Next.js 16.1.6
- Local:         http://fa45b0e6e0ad:3000
- Network:       http://fa45b0e6e0ad:3000
✓ Starting...
✓ Ready in 426ms
```

## 预览

|   |   |
| --- | --- |
| <img width="2186" height="1114" alt="image" src="https://github.com/user-attachments/assets/939424fb-1caa-4e80-a9a8-921d1770eb9f" /> | <img width="2112" height="1117" alt="image" src="https://github.com/user-attachments/assets/e5338679-7808-4f37-9753-41b559a3cee6" /> |
<img width="2133" height="1098" alt="image" src="https://github.com/user-attachments/assets/99858753-f80f-4cd6-9331-087af35b21b3" />
<img width="2166" height="973" alt="image" src="https://github.com/user-attachments/assets/6097da38-9dcc-46c0-a515-5904b81203d6" />

## 数据库高级配置

| 环境变量 | 说明 | 默认值 | 备注 |
|---|---|---|---|
| `DATABASE_POOL_MAX` | 连接池最大连接数 | `5` | 最小为 1 |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | 空闲连接超时时间 (毫秒) | `10000` | 超过此时间未使用的连接将被释放 |
| `DATABASE_POOL_CONNECTION_TIMEOUT_MS` | 获取连接超时时间 (毫秒) | `5000` | 等待连接空闲的最长时间 |
| `DATABASE_POOL_MAX_USES` | 连接最大使用次数 | `7500` | 单个连接在关闭前可执行的最大查询数 |
| `AUTH_FILES_INSERT_CHUNK_SIZE` | `auth_file_mappings` 批量插入块大小 | `500` | 大数据量时避免单条 SQL 过长 |
| `USAGE_INSERT_CHUNK_SIZE` | `usage_records` 批量插入块大小 | `1000` | 大数据量时避免单条 SQL 过长 |

## Local DEV
1. 安装依赖：`pnpm install`
2. 修改环境变量：`cp .env.example .env`
3. 创建表结构：`pnpm run db:push`
4. 同步数据：GET/POST `/api/sync`（可选）
5. 启动开发：`pnpm dev`
