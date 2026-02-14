import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq, sql } from "drizzle-orm";
import { config, assertEnv } from "@/lib/config";
import { db } from "@/lib/db/client";
import { authFileMappings, usageRecords } from "@/lib/db/schema";
import { toAuthFileMappings } from "@/lib/auth-files";
import { parseUsagePayload, toUsageRecords } from "@/lib/usage";

export const runtime = "nodejs";

const PASSWORD = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const COOKIE_NAME = "dashboard_auth";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function missingPassword() {
  return NextResponse.json({ error: "PASSWORD is missing" }, { status: 501 });
}

async function hashPassword(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAuthorized(request: Request) {
  // 检查 Bearer token（用于 cron job 等外部调用）
  const allowed = [config.password, config.cronSecret].filter(Boolean).map((v) => `Bearer ${v}`);
  if (allowed.length > 0) {
    const auth = request.headers.get("authorization") || "";
    if (allowed.includes(auth)) return true;
  }
  
  // 检查用户的 dashboard cookie（用于前端调用）
  if (PASSWORD) {
    const cookieStore = await cookies();
    const authCookie = cookieStore.get(COOKIE_NAME);
    if (authCookie) {
      const expectedToken = await hashPassword(PASSWORD);
      if (authCookie.value === expectedToken) return true;
    }
  }
  
  return false;
}

async function syncAuthFileMappings(pulledAt: Date) {
  const authFilesUrl = `${config.cliproxy.baseUrl.replace(/\/$/, "")}/auth-files`;

  const response = await fetch(authFilesUrl, {
    headers: {
      Authorization: `Bearer ${config.cliproxy.apiKey}`,
      "Content-Type": "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch auth-files: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const rows = toAuthFileMappings(json, pulledAt);
  if (rows.length === 0) return 0;

  await db
    .insert(authFileMappings)
    .values(rows)
    .onConflictDoUpdate({
      target: authFileMappings.authId,
      set: {
        name: sql`coalesce(nullif(excluded.name, ''), ${authFileMappings.name})`,
        label: sql`coalesce(nullif(excluded.label, ''), ${authFileMappings.label})`,
        provider: sql`coalesce(nullif(excluded.provider, ''), ${authFileMappings.provider})`,
        source: sql`coalesce(nullif(excluded.source, ''), ${authFileMappings.source})`,
        email: sql`coalesce(nullif(excluded.email, ''), ${authFileMappings.email})`,
        updatedAt: sql`coalesce(excluded.updated_at, ${authFileMappings.updatedAt})`,
        syncedAt: pulledAt
      }
    });

  return rows.length;
}

async function performSync(request: Request) {
  if (!config.password && !config.cronSecret && !PASSWORD) return missingPassword();
  if (!(await isAuthorized(request))) return unauthorized();

  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  const usageUrl = `${config.cliproxy.baseUrl.replace(/\/$/, "")}/usage`;
  const pulledAt = new Date();

  const response = await fetch(usageUrl, {
    headers: {
      Authorization: `Bearer ${config.cliproxy.apiKey}`,
      "Content-Type": "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    return NextResponse.json(
      { error: "Failed to fetch usage", statusText: response.statusText },
      { status: response.status }
    );
  }

  let payload;
  try {
    const json = await response.json();
    payload = parseUsagePayload(json);
  } catch (parseError) {
    console.error("/api/sync parse upstream usage failed:", parseError);
    return NextResponse.json(
      { error: "Bad Gateway" },
      { status: 502 }
    );
  }

  const rows = toUsageRecords(payload, pulledAt);

  let authFilesSynced = 0;
  let authFilesWarning: string | undefined;
  try {
    authFilesSynced = await syncAuthFileMappings(pulledAt);
  } catch (error) {
    authFilesWarning = "auth-files sync failed";
    console.warn("/api/sync auth-files sync failed:", error);
  }

  if (rows.length === 0) {
    return NextResponse.json({
      status: "ok",
      inserted: 0,
      message: "No usage data",
      authFilesSynced,
      ...(authFilesWarning ? { authFilesWarning } : {})
    });
  }

  let insertedRows: Array<{ id: number }>;
  try {
    insertedRows = await db
      .insert(usageRecords)
      .values(rows)
      .onConflictDoNothing({ target: [usageRecords.occurredAt, usageRecords.route, usageRecords.model, usageRecords.source] })
      .returning({ id: usageRecords.id });
  } catch (dbError) {
    console.error("/api/sync database insert failed:", dbError);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }

  // Vercel Postgres may return an empty array even when rows are inserted with RETURNING + ON CONFLICT DO NOTHING.
  // Fall back to counting rows synced in this run (identified by the shared pulledAt timestamp) to avoid reporting 0.
  let inserted = insertedRows.length;
  if (inserted === 0 && rows.length > 0) {
    const fallback = await db
      .select({ count: sql<number>`count(*)` })
      .from(usageRecords)
      .where(eq(usageRecords.syncedAt, pulledAt));
    inserted = Number(fallback?.[0]?.count ?? 0);
  }

  return NextResponse.json({
    status: "ok",
    inserted,
    attempted: rows.length,
    authFilesSynced,
    ...(authFilesWarning ? { authFilesWarning } : {})
  });
}

export async function POST(request: Request) {
  return performSync(request);
}

export async function GET(request: Request) {
  return performSync(request);
}
