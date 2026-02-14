import { and, eq, sql, gte, lte, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { authFileMappings, modelPrices, usageRecords } from "@/lib/db/schema";
import type { UsageOverview, ModelUsage, UsageSeriesPoint } from "@/lib/types";
import { estimateCost, priceMap } from "@/lib/usage";

type PriceRow = typeof modelPrices.$inferSelect;
type ModelAggRow = {
  model: string;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};
type TotalsRow = {
  totalRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  successCount: number;
  failureCount: number;
};
type DayAggRow = { label: string; requests: number; errors: number; tokens: number };
type DayModelAggRow = { label: string; model: string; inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number };
type HourAggRow = { 
  label: string;
  hourStart: Date | string;
  requests: number; 
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};
type OverviewMeta = { page: number; pageSize: number; totalModels: number; totalPages: number };

function toNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeDays(days?: number | null) {
  const fallback = 14;
  if (days == null || Number.isNaN(days)) return fallback;
  return Math.min(Math.max(Math.floor(days), 1), 90);
}

function parseDateInput(value?: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
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

function normalizePage(value?: number | null) {
  const fallback = 1;
  if (value == null || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizePageSize(value?: number | null) {
  const fallback = 10;
  if (value == null || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 5), 500);
}

export async function getOverview(
  daysInput?: number,
  opts?: { model?: string | null; route?: string | null; source?: string | null; name?: string | null; page?: number | null; pageSize?: number | null; start?: string | Date | null; end?: string | Date | null; timezone?: string | null }
): Promise<{ overview: UsageOverview; empty: boolean; days: number; meta: OverviewMeta; filters: { models: string[]; routes: string[]; sources: string[]; names: string[] }; timezone: string }> {
  const startDate = parseDateInput(opts?.start);
  const endDate = parseDateInput(opts?.end);
  const hasCustomRange = startDate && endDate && endDate >= startDate;

  const days = hasCustomRange ? Math.max(1, Math.round((withDayEnd(endDate).getTime() - withDayStart(startDate).getTime()) / DAY_MS) + 1) : normalizeDays(daysInput);
  const page = normalizePage(opts?.page ?? undefined);
  const pageSize = normalizePageSize(opts?.pageSize ?? undefined);
  const offset = (page - 1) * pageSize;
  const since = hasCustomRange ? withDayStart(startDate!) : new Date(Date.now() - days * DAY_MS);
  const until = hasCustomRange ? withDayEnd(endDate!) : undefined;

  const baseWhereParts: SQL[] = [gte(usageRecords.occurredAt, since)];
  if (until) baseWhereParts.push(lte(usageRecords.occurredAt, until));
  const baseWhere = baseWhereParts.length ? and(...baseWhereParts) : undefined;

  const filterWhereParts: SQL[] = [...baseWhereParts];
  if (opts?.model) filterWhereParts.push(eq(usageRecords.model, opts.model));
  if (opts?.route) filterWhereParts.push(eq(usageRecords.route, opts.route));
  if (opts?.source) filterWhereParts.push(eq(usageRecords.source, opts.source));
  if (opts?.name) {
    filterWhereParts.push(
      sql`coalesce(
        nullif((select af.name from auth_file_mappings af where af.auth_id = ${usageRecords.authIndex} limit 1), ''),
        nullif(${usageRecords.source}, ''),
        '-'
      ) = ${opts.name}`
    );
  }
  const filterWhere = filterWhereParts.length ? and(...filterWhereParts) : undefined;

  const tz = opts?.timezone || "Asia/Shanghai";
  // Use sql.raw() so the timezone is embedded as a SQL literal rather than a query
  // parameter. PostgreSQL requires the GROUP BY expression to be textually identical
  // to the SELECT expression; different parameter indices ($1 vs $3) would cause a
  // "must appear in GROUP BY" error even when the values are equal.
  const tzLiteral = sql.raw(`'${tz}'`);
  const dayExpr = sql`date_trunc('day', ${usageRecords.occurredAt} at time zone ${tzLiteral})`;
  const hourExpr = sql`date_trunc('hour', ${usageRecords.occurredAt} at time zone ${tzLiteral})`;
  const credentialNameExpr = sql<string>`coalesce(nullif(${authFileMappings.name}, ''), nullif(${usageRecords.source}, ''), '-')`;

  const totalsPromise: Promise<TotalsRow[]> = db
    .select({
      totalRequests: sql<number>`count(*)`,
      totalTokens: sql<number>`coalesce(sum(${usageRecords.totalTokens}), 0)`,
      inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`,
      successCount: sql<number>`coalesce(sum(case when ${usageRecords.isError} then 0 else 1 end), 0)`,
      failureCount: sql<number>`coalesce(sum(case when ${usageRecords.isError} then 1 else 0 end), 0)`
    })
    .from(usageRecords)
    .where(filterWhere);

  const pricePromise: Promise<PriceRow[]> = db.select().from(modelPrices);

  const totalModelsPromise: Promise<{ count: number }[]> = db
    .select({ count: sql<number>`count(distinct ${usageRecords.model})` })
    .from(usageRecords)
    .where(filterWhere);

  const byModelPromise: Promise<ModelAggRow[]> = db
    .select({
      model: usageRecords.model,
      requests: sql<number>`count(*)`,
      tokens: sql<number>`sum(${usageRecords.totalTokens})`,
      inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
      outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
      reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`
    })
    .from(usageRecords)
    .where(filterWhere)
    .groupBy(usageRecords.model)
    .orderBy(usageRecords.model)
    .limit(pageSize)
    .offset(offset);

  const byDayPromise: Promise<DayAggRow[]> = db
    .select({
      label: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`,
      requests: sql<number>`count(*)`,
      errors: sql<number>`coalesce(sum(case when ${usageRecords.isError} then 1 else 0 end), 0)`,
      tokens: sql<number>`sum(${usageRecords.totalTokens})`
    })
    .from(usageRecords)
    .where(filterWhere)
    .groupBy(dayExpr)
    .orderBy(desc(dayExpr))
    .limit(days);

  const byDayModelPromise: Promise<DayModelAggRow[]> = db
    .select({
      label: sql<string>`to_char(${dayExpr}, 'YYYY-MM-DD')`,
      model: usageRecords.model,
      inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
      outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
      reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`
    })
    .from(usageRecords)
    .where(filterWhere)
    .groupBy(dayExpr, usageRecords.model)
    .orderBy(dayExpr, usageRecords.model);

  const byHourPromise: Promise<HourAggRow[]> = db
    .select({
      label: sql<string>`to_char(${hourExpr}, 'MM-DD HH24')`,
      hourStart: sql<Date>`(${hourExpr}) at time zone ${tzLiteral}`,
      requests: sql<number>`count(*)`,
      tokens: sql<number>`sum(${usageRecords.totalTokens})`,
      inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
      outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
      reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`
    })
    .from(usageRecords)
    .where(filterWhere)
    .groupBy(hourExpr)
    .orderBy(hourExpr);

  const availableModelsPromise: Promise<{ model: string }[]> = db
    .select({ model: usageRecords.model })
    .from(usageRecords)
    .where(baseWhere)
    .groupBy(usageRecords.model)
    .orderBy(usageRecords.model);

  const availableRoutesPromise: Promise<{ route: string }[]> = db
    .select({ route: usageRecords.route })
    .from(usageRecords)
    .where(baseWhere)
    .groupBy(usageRecords.route)
    .orderBy(usageRecords.route);

  const availableSourcesPromise: Promise<{ source: string }[]> = db
    .select({ source: usageRecords.source })
    .from(usageRecords)
    .where(baseWhere)
    .groupBy(usageRecords.source)
    .orderBy(usageRecords.source);

  const availableNamesPromise: Promise<{ name: string | null }[]> = db
    .select({ name: credentialNameExpr })
    .from(usageRecords)
    .leftJoin(authFileMappings, eq(usageRecords.authIndex, authFileMappings.authId))
    .where(baseWhere)
    .groupBy(credentialNameExpr)
    .orderBy(credentialNameExpr);

  const [
    totalsRowResult,
    priceRows,
    totalModelsRowResult,
    byModelRows,
    byDayRows,
    byDayModelRows,
    byHourRows,
    availableModelsRows,
    availableRoutesRows,
    availableSourcesRows,
    availableNamesRows
  ] = await Promise.all([
    totalsPromise,
    pricePromise,
    totalModelsPromise,
    byModelPromise,
    byDayPromise,
    byDayModelPromise,
    byHourPromise,
    availableModelsPromise,
    availableRoutesPromise,
    availableSourcesPromise,
    availableNamesPromise
  ]);

  const totalsRow =
    totalsRowResult[0] ?? { totalRequests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, successCount: 0, failureCount: 0 };

  const totalModelsRow = totalModelsRowResult[0] ?? { count: 0 };
  const prices = priceMap(
    priceRows.map((p: PriceRow) => ({
      model: p.model,
      inputPricePer1M: Number(p.inputPricePer1M),
      cachedInputPricePer1M: Number(p.cachedInputPricePer1M),
      outputPricePer1M: Number(p.outputPricePer1M)
    }))
  );

  const models: ModelUsage[] = byModelRows.map((row) => {
    const cost = estimateCost(
      {
        inputTokens: toNumber(row.inputTokens),
        cachedTokens: toNumber(row.cachedTokens),
        outputTokens: toNumber(row.outputTokens),
        reasoningTokens: toNumber(row.reasoningTokens)
      },
      row.model,
      prices
    );
    return {
      model: row.model,
      requests: toNumber(row.requests),
      tokens: toNumber(row.tokens),
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      cost
    };
  });

  const dailyCostMap = new Map<string, number>();
  for (const row of byDayModelRows) {
    const cost = estimateCost(
      {
        inputTokens: toNumber(row.inputTokens),
        cachedTokens: toNumber(row.cachedTokens),
        outputTokens: toNumber(row.outputTokens),
        reasoningTokens: toNumber(row.reasoningTokens)
      },
      row.model,
      prices
    );
    dailyCostMap.set(row.label, (dailyCostMap.get(row.label) ?? 0) + cost);
  }

  const byDay: UsageSeriesPoint[] = [...byDayRows].reverse().map((row) => ({
    label: row.label,
    requests: toNumber(row.requests),
    errors: toNumber(row.errors),
    tokens: toNumber(row.tokens),
    cost: Number((dailyCostMap.get(row.label) ?? 0).toFixed(2))
  }));

  const byHour: UsageSeriesPoint[] = byHourRows.map((row) => ({
    label: row.label,
    timestamp: (() => {
      const d = new Date(row.hourStart as string);
      return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
    })(),
    requests: toNumber(row.requests),
    tokens: toNumber(row.tokens),
    inputTokens: toNumber(row.inputTokens),
    outputTokens: toNumber(row.outputTokens),
    reasoningTokens: toNumber(row.reasoningTokens),
    cachedTokens: toNumber(row.cachedTokens)
  }));

  const totalCost = models.reduce((acc, cur) => acc + cur.cost, 0);
  const totalRequests = toNumber(totalsRow.totalRequests);
  const successCount = toNumber(totalsRow.successCount);
  const failureCount = toNumber(totalsRow.failureCount);
  const successRate = totalRequests === 0 ? 1 : successCount / totalRequests;

  const overview: UsageOverview = {
    totalRequests,
    totalTokens: toNumber(totalsRow.totalTokens),
    totalInputTokens: toNumber(totalsRow.inputTokens),
    totalOutputTokens: toNumber(totalsRow.outputTokens),
    totalReasoningTokens: toNumber(totalsRow.reasoningTokens),
    totalCachedTokens: toNumber(totalsRow.cachedTokens),
    successCount,
    failureCount,
    successRate,
    totalCost: Number(totalCost.toFixed(4)),
    models,
    byDay,
    byHour
  };

  const totalModels = toNumber(totalModelsRow.count);
  const totalPages = Math.max(1, Math.ceil(totalModels / pageSize));

  const filters = {
    models: availableModelsRows.map((r) => r.model).filter(Boolean),
    routes: availableRoutesRows.map((r) => r.route).filter(Boolean),
    sources: availableSourcesRows.map((r) => r.source).filter(Boolean),
    names: availableNamesRows.map((r) => r.name).filter((name): name is string => Boolean(name) && name !== "-")
  };

  return {
    overview,
    empty: totalRequests === 0,
    days,
    meta: { page, pageSize, totalModels, totalPages },
    filters,
    timezone: tz
  };
}
