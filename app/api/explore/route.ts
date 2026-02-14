import { NextResponse } from "next/server";
import { assertEnv } from "@/lib/config";
import { getExplorePoints } from "@/lib/queries/explore";

export const runtime = "nodejs";

type CachedExplore = {
  expiresAt: number;
  value: Awaited<ReturnType<typeof getExplorePoints>>;
};

const EXPLORE_CACHE_TTL_MS = 30_000;
const EXPLORE_CACHE_MAX_ENTRIES = 100;
const exploreCache = new Map<string, CachedExplore>();

function makeCacheKey(input: { days?: number; maxPoints?: number; start?: string | null; end?: string | null; route?: string | null; name?: string | null }) {
  return JSON.stringify({
    days: input.days ?? null,
    maxPoints: input.maxPoints ?? null,
    start: input.start ?? null,
    end: input.end ?? null,
    route: input.route ?? null,
    name: input.name ?? null
  });
}

function getCached(key: string) {
  const entry = exploreCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    exploreCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key: string, value: CachedExplore["value"]) {
  if (exploreCache.size >= EXPLORE_CACHE_MAX_ENTRIES) {
    const oldestKey = exploreCache.keys().next().value as string | undefined;
    if (oldestKey) exploreCache.delete(oldestKey);
  }
  exploreCache.set(key, { expiresAt: Date.now() + EXPLORE_CACHE_TTL_MS, value });
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
    const maxPointsParam = searchParams.get("maxPoints");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const route = searchParams.get("route");
    const name = searchParams.get("name");

    const days = daysParam ? Number.parseInt(daysParam, 10) : undefined;
    const maxPoints = maxPointsParam ? Number.parseInt(maxPointsParam, 10) : undefined;

    const cacheKey = makeCacheKey({ days, maxPoints, start, end, route, name });
    const cached = getCached(cacheKey);
    if (cached) {
      return NextResponse.json(cached, { status: 200 });
    }

    const payload = await getExplorePoints(days, { maxPoints, start, end, route, name });
    setCached(cacheKey, payload);
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("/api/explore failed:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
