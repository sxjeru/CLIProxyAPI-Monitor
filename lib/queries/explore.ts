import { sql, and, eq, gte, lte } from "drizzle-orm";
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

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeDays(days?: number | null) {
  const fallback = 14;
  if (days == null || Number.isNaN(days)) return fallback;
  return Math.min(Math.max(Math.floor(days), 1), 90);
}

function parseDateInput(value?: string | Date | null) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function withDayStart(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function withDayEnd(date: Date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function normalizeMaxPoints(value?: number | null) {
  const fallback = 20_000;
  if (value == null || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1_000), 100_000);
}

export async function getExplorePoints(
  daysInput?: number,
  opts?: {
    maxPoints?: number | null;
    start?: string | Date | null;
    end?: string | Date | null;
    route?: string | null;
    name?: string | null;
  }
) {
  const startDate = parseDateInput(opts?.start);
  const endDate = parseDateInput(opts?.end);
  const hasCustomRange = startDate && endDate && endDate >= startDate;

  const days = hasCustomRange
    ? Math.max(1, Math.round((withDayEnd(endDate).getTime() - withDayStart(startDate).getTime()) / DAY_MS) + 1)
    : normalizeDays(daysInput);
  const maxPoints = normalizeMaxPoints(opts?.maxPoints ?? null);
  const since = hasCustomRange ? withDayStart(startDate!) : new Date(Date.now() - days * DAY_MS);
  const until = hasCustomRange ? withDayEnd(endDate!) : undefined;

  const baseWhereParts: SQL[] = [gte(usageRecords.occurredAt, since)];
  if (until) baseWhereParts.push(lte(usageRecords.occurredAt, until));

  const whereParts: SQL[] = [...baseWhereParts];
  if (opts?.route) whereParts.push(eq(usageRecords.route, opts.route));
  if (opts?.name) {
    whereParts.push(
      sql`coalesce(
        nullif((select af.name from auth_file_mappings af where af.auth_id = ${usageRecords.authIndex} limit 1), ''),
        nullif(${usageRecords.source}, ''),
        '-'
      ) = ${opts.name}`
    );
  }
  const where = and(...whereParts);
  const baseWhere = and(...baseWhereParts);

  const credentialNameExpr = sql<string>`coalesce(
    nullif((select af.name from auth_file_mappings af where af.auth_id = ${usageRecords.authIndex} limit 1), ''),
    nullif(${usageRecords.source}, ''),
    '-'
  )`;

  const [totalRows, availableRouteRows, availableNameRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(usageRecords)
      .where(where),
    db
      .select({ route: usageRecords.route })
      .from(usageRecords)
      .where(baseWhere)
      .groupBy(usageRecords.route)
      .orderBy(usageRecords.route)
      .limit(200),
    db
      .select({ name: credentialNameExpr })
      .from(usageRecords)
      .where(baseWhere)
      .groupBy(credentialNameExpr)
      .orderBy(credentialNameExpr)
      .limit(200)
  ]);

  const total = Number(totalRows?.[0]?.count ?? 0);
  const filters = {
    routes: availableRouteRows.map((row) => row.route).filter(Boolean),
    names: availableNameRows.map((row) => row.name).filter((name): name is string => Boolean(name) && name !== "-")
  };

  if (total <= 0) {
    return { days, total: 0, returned: 0, step: 1, points: [] as ExplorePoint[], filters };
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
    filters,
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
