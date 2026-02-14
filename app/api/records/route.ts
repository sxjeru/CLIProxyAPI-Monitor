import { NextResponse } from "next/server";
import { assertEnv } from "@/lib/config";
import { getUsageRecords } from "@/lib/queries/records";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const sortField = searchParams.get("sortField") as
      | "occurredAt"
      | "model"
      | "route"
      | "source"
      | "totalTokens"
      | "inputTokens"
      | "outputTokens"
      | "reasoningTokens"
      | "cachedTokens"
      | "cost"
      | "isError"
      | null;
    const sortOrder = searchParams.get("sortOrder") as "asc" | "desc" | null;
    const cursor = searchParams.get("cursor");
    const model = searchParams.get("model");
    const route = searchParams.get("route");
    const source = searchParams.get("source");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const includeFilters = searchParams.get("includeFilters") === "1";

    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

    const payload = await getUsageRecords({
      limit,
      sortField: sortField ?? undefined,
      sortOrder: sortOrder ?? undefined,
      cursor,
      model: model || undefined,
      route: route || undefined,
      source: source || undefined,
      start,
      end,
      includeFilters
    });

    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("/api/records failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}