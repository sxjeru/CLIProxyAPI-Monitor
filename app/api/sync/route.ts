import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq, sql } from "drizzle-orm";
import { config, assertEnv } from "@/lib/config";
import { db } from "@/lib/db/client";
import { usageRecords } from "@/lib/db/schema";
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

async function fetchAuthIndexMapping(): Promise<Map<string, string>> {
  // 从 CLIProxyAPI 的 /auth-files 接口获取 auth_index -> 渠道名的映射
  try {
    const baseUrl = config.cliproxy.baseUrl.replace(/\/$/, "");
    const url = baseUrl.endsWith("/v0/management")
      ? `${baseUrl}/auth-files`
      : `${baseUrl}/v0/management/auth-files`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.cliproxy.apiKey}`,
        "Content-Type": "application/json"
      },
      cache: "no-store"
    });

    const map = new Map<string, string>();
    if (!res.ok) {
      console.warn(`Failed to fetch auth files mapping: ${res.status} ${res.statusText}`);
      return map;
    }

    const data = (await res.json()) as { files?: Array<{ auth_index?: string; provider?: string; name?: string; email?: string }> };
    for (const file of data.files ?? []) {
      if (file.auth_index) {
        // 用 "provider/name" 作为可读的渠道名
        const channelName = [file.provider, file.name]
          .filter(Boolean)
          .join("/");
        map.set(String(file.auth_index), channelName || file.auth_index);
      }
    }
    return map;
  } catch (error) {
    console.warn("Error fetching auth index mapping:", error);
    return new Map();
  }
}

async function fetchApiKeyChannelMapping(): Promise<Map<string, string>> {
  // 从 4 个 API key 端点获取 api-key -> 渠道名的映射
  // 当 auth_index 无法通过 /auth-files 匹配时，用 source 匹配这些 api-key
  try {
    const baseUrl = config.cliproxy.baseUrl.replace(/\/$/, "");
    const prefix = baseUrl.endsWith("/v0/management") ? baseUrl : `${baseUrl}/v0/management`;
    const headers = {
      Authorization: `Bearer ${config.cliproxy.apiKey}`,
      "Content-Type": "application/json"
    };

    const endpoints = [
      "openai-compatibility",
      "claude-api-key",
      "codex-api-key",
      "gemini-api-key"
    ] as const;

    const results = await Promise.allSettled(
      endpoints.map((ep) =>
        fetch(`${prefix}/${ep}`, { headers, cache: "no-store" }).then((r) =>
          r.ok ? r.json() : null
        )
      )
    );

    const map = new Map<string, string>();

    for (let i = 0; i < endpoints.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled" || !result.value) continue;
      const data = result.value;
      const ep = endpoints[i];

      if (ep === "openai-compatibility") {
        // 结构: { "openai-compatibility": [{ name, api-key-entries: [{ api-key }] }] }
        const entries = data["openai-compatibility"] as Array<{
          name?: string;
          "api-key-entries"?: Array<{ "api-key"?: string }>;
        }> | undefined;
        for (const entry of entries ?? []) {
          const channelName = entry.name || ep;
          for (const keyEntry of entry["api-key-entries"] ?? []) {
            if (keyEntry["api-key"] && !map.has(keyEntry["api-key"])) {
              map.set(keyEntry["api-key"], channelName);
            }
          }
        }
      } else {
        // 结构: { "<ep>": [{ api-key, base-url }] }
        const entries = data[ep] as Array<{
          "api-key"?: string;
          "base-url"?: string;
        }> | undefined;
        for (const entry of entries ?? []) {
          if (entry["api-key"] && !map.has(entry["api-key"])) {
            map.set(entry["api-key"], entry["base-url"] || ep);
          }
        }
      }
    }

    return map;
  } catch (error) {
    console.warn("Error fetching API key channel mapping:", error);
    return new Map();
  }
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

  // 获取 auth_index 到渠道名的映射（并行请求）
  const [authMap, apiKeyMap] = await Promise.all([
    fetchAuthIndexMapping(),
    fetchApiKeyChannelMapping()
  ]);

  const rows = toUsageRecords(payload, pulledAt, authMap, apiKeyMap);

  if (rows.length === 0) {
    return NextResponse.json({ status: "ok", inserted: 0, message: "No usage data" });
  }

  let insertedRows: Array<{ id: number }>;
  try {
    insertedRows = await db
      .insert(usageRecords)
      .values(rows)
      .onConflictDoNothing({ target: [usageRecords.occurredAt, usageRecords.route, usageRecords.model] })
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

  return NextResponse.json({ status: "ok", inserted, attempted: rows.length });
}

export async function POST(request: Request) {
  return performSync(request);
}

export async function GET(request: Request) {
  return performSync(request);
}
