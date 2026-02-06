#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/vercel-postgres";
import { createPool } from "@vercel/postgres";
import { migrate } from "drizzle-orm/vercel-postgres/migrator";

// 加载 .env.local（Next.js 不会为独立 Node 脚本加载）
for (const envFile of [".env.local", ".env"]) {
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    break;
  }
}

const pool = createPool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL
});

const db = drizzle(pool);

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
  try {
    console.log("检查迁移表...");
    
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
        existingHashes.add(initialMigration.hash);
        console.log("✓ 已标记 0000 迁移");
      }

      // 检查 0001 迁移（DROP total_requests/success_count/failure_count）
      // 如果这些列已不存在，说明 0001 已在结构上生效，需要标记
      const migration0001 = allMigrations.find((m) => m.tag.startsWith("0001_"));
      if (migration0001 && !existingHashes.has(migration0001.hash)) {
        const columnsResult = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_records' AND column_name IN ('total_requests', 'success_count', 'failure_count')"
        );
        if (columnsResult.rows.length === 0) {
          console.log("检测到 0001 迁移已在结构上生效但未标记，正在标记...");
          await pool.query(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
            [migration0001.hash, migration0001.createdAt]
          );
          existingHashes.add(migration0001.hash);
          console.log("✓ 已标记 0001 迁移");
        }
      }
    }

    console.log("执行数据库迁移...");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✓ 迁移完成");
    
    process.exit(0);
  } catch (error) {
    console.error("迁移失败:", error);
    // 不阻止构建继续
    process.exit(0);
  }
}

runMigrations();
