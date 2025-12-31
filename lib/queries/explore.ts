import { sql, and, gte, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageRecords } from "@/lib/db/schema";

export type ExplorePoint = {
  ts: number; // epoch ms
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  model: string;
};

function normalizeDays(days?: number | null) {
  const fallback = 14;
  if (days == null || Number.isNaN(days)) return fallback;
  return Math.min(Math.max(Math.floor(days), 1), 90);
}

function normalizeMaxPoints(value?: number | null) {
  const fallback = 20_000;
  if (value == null || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1_000), 100_000);
}

export async function getExplorePoints(daysInput?: number, opts?: { maxPoints?: number | null }) {
  const days = normalizeDays(daysInput);
  const maxPoints = normalizeMaxPoints(opts?.maxPoints ?? null);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const whereParts: SQL[] = [gte(usageRecords.occurredAt, since), eq(usageRecords.totalRequests, 1)];
  const where = and(...whereParts);

  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(usageRecords)
    .where(where);

  const total = Number(totalRows?.[0]?.count ?? 0);
  if (total <= 0) {
    return { days, total: 0, returned: 0, step: 1, points: [] as ExplorePoint[] };
  }

  const step = total > maxPoints ? Math.ceil(total / maxPoints) : 1;

  // Use row_number() sampling for stable, time-ordered down-sampling.
  const points = await db
    .select({
      ts: sql<number>`(extract(epoch from sampled.occurred_at) * 1000)::bigint`,
      tokens: sql<number>`sampled.total_tokens`,
      inputTokens: sql<number>`sampled.input_tokens`,
      outputTokens: sql<number>`sampled.output_tokens`,
      reasoningTokens: sql<number>`sampled.reasoning_tokens`,
      cachedTokens: sql<number>`sampled.cached_tokens`,
      model: sql<string>`sampled.model`
    })
    .from(
      sql`(
        select
          ${usageRecords.occurredAt} as occurred_at,
          ${usageRecords.totalTokens} as total_tokens,
          ${usageRecords.inputTokens} as input_tokens,
          ${usageRecords.outputTokens} as output_tokens,
          ${usageRecords.reasoningTokens} as reasoning_tokens,
          ${usageRecords.cachedTokens} as cached_tokens,
          ${usageRecords.model} as model,
          row_number() over (order by ${usageRecords.occurredAt}) as rn
        from ${usageRecords}
        where ${where}
      ) as sampled`
    )
    .where(sql`(sampled.rn - 1) % ${step} = 0`)
    .orderBy(sql`sampled.occurred_at`)
    .limit(maxPoints);

  return {
    days,
    total,
    returned: points.length,
    step,
    points: points.map((p) => ({
      ts: Number(p.ts),
      tokens: Number(p.tokens ?? 0),
      inputTokens: Number((p as any).inputTokens ?? 0),
      outputTokens: Number((p as any).outputTokens ?? 0),
      reasoningTokens: Number((p as any).reasoningTokens ?? 0),
      cachedTokens: Number((p as any).cachedTokens ?? 0),
      model: String(p.model ?? "")
    }))
  };
}
