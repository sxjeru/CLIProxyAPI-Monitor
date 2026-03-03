#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || "";

// 驱动选择策略（与 lib/db/client.ts 保持一致）
const useNeon =
  process.env.DATABASE_DRIVER === "neon" ||
  (process.env.DATABASE_DRIVER !== "pg" &&
    /\.neon\.tech/.test(connectionString));

// SSL 配置：DATABASE_CA 支持原始 PEM 或 Base64 编码
function getSSLOptions() {
  const ca = process.env.DATABASE_CA;
  if (!ca) return undefined;
  const pem = ca.startsWith("-----BEGIN") ? ca : Buffer.from(ca, "base64").toString("utf8");
  return { ca: pem, rejectUnauthorized: true };
}

async function createMigrateContext() {
  if (useNeon) {
    const { Pool, neonConfig } = await import("@neondatabase/serverless");
    const { WebSocket } = await import("ws");
    neonConfig.webSocketConstructor = WebSocket;
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
    const pool = new Pool({ connectionString });
    const db = drizzle(pool);
    return { pool, db, migrate };
  } else {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new pg.default.Pool({ connectionString, ssl: getSSLOptions() });
    const db = drizzle(pool);
    return { pool, db, migrate };
  }
}

function getMigrationMeta(migrationsFolder) {
  const journalPath = `${migrationsFolder}/meta/_journal.json`;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));

  return journal.entries.map((entry) => {
    const sql = readFileSync(`${migrationsFolder}/${entry.tag}.sql`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");

    return {
      tag: entry.tag,
      hash,
      createdAt: entry.when
    };
  });
}

async function runMigrations() {
  const { pool, db, migrate } = await createMigrateContext();
  try {
    console.log(`检查迁移表... (驱动: ${useNeon ? "neon-serverless" : "pg"})`);
    
    await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT)"
    );

    // 获取本地所有迁移元数据
    const allMigrations = getMigrationMeta("./drizzle");
    
    // 检查数据库中已有的迁移记录
    const existingMigrations = await pool.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations"
    );
    const existingHashes = new Set(existingMigrations.rows.map((r) => r.hash));

    // 检查 model_prices 表是否存在
    const tableExists = await pool.query(
      "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'model_prices' AND c.relkind IN ('r','p') LIMIT 1"
    );

    // 如果表已存在，需要确保对应的迁移已标记
    if (tableExists.rows.length > 0) {
      // 找出 0000 迁移
      const initialMigration = allMigrations.find((m) => m.tag.startsWith("0000_"));
      
      if (initialMigration && !existingHashes.has(initialMigration.hash)) {
        console.log("检测到表已存在但迁移未标记，正在标记...");
        await pool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [initialMigration.hash, initialMigration.createdAt]
        );
        console.log("✓ 已标记 0000 迁移");
      }
    }

    console.log("执行数据库迁移...");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✓ 迁移完成");
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("迁移失败:", error);
    try { await pool.end(); } catch {}
    // 不阻止构建继续
    process.exit(0);
  }
}

runMigrations();
