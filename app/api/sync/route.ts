import { NextResponse } from "next/server";
import { config, assertEnv } from "@/lib/config";
import { db } from "@/lib/db/client";
import { usageRecords } from "@/lib/db/schema";
import { parseUsagePayload, toUsageRecords } from "@/lib/usage";

export const runtime = "nodejs";

export async function POST() {
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
    return NextResponse.json(
      { error: "Failed to parse usage response", detail: (parseError as Error).message },
      { status: 502 }
    );
  }

  const rows = toUsageRecords(payload, pulledAt);

  if (rows.length === 0) {
    return NextResponse.json({ status: "ok", inserted: 0, message: "No usage data" });
  }

  let result;
  try {
    result = await db
      .insert(usageRecords)
      .values(rows)
      .onConflictDoNothing({ target: [usageRecords.occurredAt, usageRecords.route, usageRecords.model] });
  } catch (dbError) {
    return NextResponse.json(
      { error: "Database insert failed", detail: (dbError as Error).message },
      { status: 500 }
    );
  }

  return NextResponse.json({ status: "ok", inserted: rows.length, db: result });
}

export const GET = POST;
