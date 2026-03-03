import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import { drizzle as neonDrizzle } from "drizzle-orm/neon-serverless";
import { Pool as PgPool } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { WebSocket } from "ws";

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

/**
 * 驱动选择策略：
 *   DATABASE_DRIVER=neon  → 强制使用 Neon 无服务器 WebSocket 驱动
 *   DATABASE_DRIVER=pg    → 强制使用标准 pg TCP 驱动（Aiven、Supabase、RDS 等）
 *   未设置               → 自动检测：URL 含 .neon.tech 则选 Neon，否则默认选 pg
 */
const useNeon =
  process.env.DATABASE_DRIVER === "neon" ||
  (process.env.DATABASE_DRIVER !== "pg" &&
    /\.neon\.tech/.test(connectionString));

/**
 * SSL 配置（仅对 pg 驱动生效）：
 *   DATABASE_CA  → CA 证书 PEM 内容（原始 PEM 或 Base64 编码均可）
 *                  例：Aiven sslmode=verify-full 时需要
 */
function getSSLOptions(): object | undefined {
  const ca = process.env.DATABASE_CA;
  if (!ca) return undefined;
  // 支持原始 PEM（-----BEGIN...）和 Base64 编码
  const pem = ca.startsWith("-----BEGIN") ? ca : Buffer.from(ca, "base64").toString("utf8");
  return { ca: pem, rejectUnauthorized: true };
}

function createDb() {
  if (useNeon) {
    neonConfig.webSocketConstructor = WebSocket;
    return neonDrizzle(new NeonPool({ connectionString }));
  }
  return pgDrizzle(new PgPool({ connectionString, ssl: getSSLOptions() }));
}

export const db = createDb();

