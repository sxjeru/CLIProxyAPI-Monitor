import { NextResponse } from "next/server";
import { assertEnv, config } from "@/lib/config";
import { getOverview } from "@/lib/queries/overview";

export const runtime = "nodejs";

type CachedOverview = {
  expiresAt: number;
  value: {
    overview: Awaited<ReturnType<typeof getOverview>>["overview"] | null;
    empty: boolean;
    days: number;
    timezone: string;
    meta?: Awaited<ReturnType<typeof getOverview>>["meta"];
    filters?: Awaited<ReturnType<typeof getOverview>>["filters"];
  };
};

const OVERVIEW_CACHE_TTL_MS = 30_000;
const OVERVIEW_CACHE_MAX_ENTRIES = 100;
const overviewCache = new Map<string, CachedOverview>();

function makeCacheKey(input: { days?: number; model?: string | null; route?: string | null; page?: number; pageSize?: number; start?: string | null; end?: string | null }) {
  return JSON.stringify({
    days: input.days ?? null,
    model: input.model ?? null,
    route: input.route ?? null,
    page: input.page ?? null,
    pageSize: input.pageSize ?? null,
    start: input.start ?? null,
    end: input.end ?? null
  });
}

function getCached(key: string) {
  const entry = overviewCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    overviewCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key: string, value: CachedOverview["value"]) {
  if (overviewCache.size >= OVERVIEW_CACHE_MAX_ENTRIES) {
    const oldestKey = overviewCache.keys().next().value as string | undefined;
    if (oldestKey) overviewCache.delete(oldestKey);
  }
  overviewCache.set(key, { expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS, value });
}

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days");
    const days = daysParam ? Number.parseInt(daysParam, 10) : undefined;
    const model = searchParams.get("model");
    const route = searchParams.get("route");
    const pageParam = searchParams.get("page");
    const pageSizeParam = searchParams.get("pageSize");
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    const page = pageParam ? Number.parseInt(pageParam, 10) : undefined;
    const pageSize = pageSizeParam ? Number.parseInt(pageSizeParam, 10) : undefined;
    const skipCacheParam = searchParams.get("skipCache");
    const skipCache = skipCacheParam === "1" || skipCacheParam === "true";
    const cacheKey = makeCacheKey({ days, model, route, page, pageSize, start, end });
    if (!skipCache) {
      const cached = getCached(cacheKey);
      if (cached) {
        return NextResponse.json(cached, { status: 200 });
      }
    }

    const { overview, empty, days: appliedDays, meta, filters, timezone } = await getOverview(days, {
      model: model || undefined,
      route: route || undefined,
      page,
      pageSize,
      start,
      end,
      timezone: config.timezone
    });

    const payload = { overview, empty, days: appliedDays, meta, filters, timezone };
    setCached(cacheKey, payload);
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("/api/overview failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
