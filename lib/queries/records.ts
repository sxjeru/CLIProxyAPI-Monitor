import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { modelPrices, usageRecords } from "@/lib/db/schema";

export type UsageRecordRow = {
  id: number;
  occurredAt: Date;
  route: string;
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  isError: boolean;
  cost: number;
};

export type UsageRecordCursor = {
  lastValue: string | number;
  lastId: number;
};

type SortField =
  | "occurredAt"
  | "model"
  | "route"
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "reasoningTokens"
  | "cachedTokens"
  | "cost"
  | "isError";
type SortOrder = "asc" | "desc";

const COST_EXPR = sql<number>`coalesce((
  select (
    (greatest(${usageRecords.inputTokens} - ${usageRecords.cachedTokens}, 0)::numeric / 1000000) * mp.input_price_per_1m
    + (${usageRecords.cachedTokens}::numeric / 1000000) * mp.cached_input_price_per_1m
    + ((${usageRecords.outputTokens} + ${usageRecords.reasoningTokens})::numeric / 1000000) * mp.output_price_per_1m
  )
  from ${sql.raw("model_prices")} mp
  where ${usageRecords.model} = mp.model
     or ${usageRecords.model} ILIKE replace(mp.model, '*', '%')
  order by (${usageRecords.model} = mp.model) desc, length(mp.model) desc
  limit 1
), 0)`;

function parseCursor(input: string | null): UsageRecordCursor | null {
  if (!input) return null;
  try {
    const raw = Buffer.from(input, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as UsageRecordCursor;
    if (parsed && typeof parsed.lastId === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function buildCursorWhere(
  sortField: SortField,
  sortOrder: SortOrder,
  cursor: UsageRecordCursor | null,
  sortExpr: SQL
): SQL | undefined {
  if (!cursor) return undefined;

  const { lastValue, lastId } = cursor;

  if (sortField === "occurredAt") {
    const lastDate = new Date(String(lastValue));
    if (!Number.isFinite(lastDate.getTime())) return undefined;
    return sortOrder === "asc"
      ? sql`(${usageRecords.occurredAt} > ${lastDate} OR (${usageRecords.occurredAt} = ${lastDate} AND ${usageRecords.id} > ${lastId}))`
      : sql`(${usageRecords.occurredAt} < ${lastDate} OR (${usageRecords.occurredAt} = ${lastDate} AND ${usageRecords.id} < ${lastId}))`;
  }

  return sortOrder === "asc"
    ? sql`(${sortExpr} > ${lastValue} OR (${sortExpr} = ${lastValue} AND ${usageRecords.id} > ${lastId}))`
    : sql`(${sortExpr} < ${lastValue} OR (${sortExpr} = ${lastValue} AND ${usageRecords.id} < ${lastId}))`;
}

export async function getUsageRecords(input: {
  limit?: number;
  sortField?: SortField;
  sortOrder?: SortOrder;
  cursor?: string | null;
  model?: string | null;
  route?: string | null;
  start?: string | null;
  end?: string | null;
  includeFilters?: boolean;
}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const sortField: SortField = input.sortField ?? "occurredAt";
  const sortOrder: SortOrder = input.sortOrder ?? "desc";
  const cursor = parseCursor(input.cursor ?? null);

  const whereParts: SQL[] = [];

  if (input.start) {
    const startDate = new Date(input.start);
    if (Number.isFinite(startDate.getTime())) {
      whereParts.push(gte(usageRecords.occurredAt, startDate));
    }
  }

  if (input.end) {
    const endDate = new Date(input.end);
    if (Number.isFinite(endDate.getTime())) {
      whereParts.push(lte(usageRecords.occurredAt, endDate));
    }
  }

  if (input.model) {
    whereParts.push(eq(usageRecords.model, input.model));
  }

  if (input.route) {
    whereParts.push(eq(usageRecords.route, input.route));
  }

  const sortExpr = (() => {
    switch (sortField) {
      case "model":
        return usageRecords.model;
      case "route":
        return usageRecords.route;
      case "totalTokens":
        return usageRecords.totalTokens;
      case "inputTokens":
        return usageRecords.inputTokens;
      case "outputTokens":
        return usageRecords.outputTokens;
      case "reasoningTokens":
        return usageRecords.reasoningTokens;
      case "cachedTokens":
        return usageRecords.cachedTokens;
      case "cost":
        return COST_EXPR;
      case "isError":
        return usageRecords.isError;
      case "occurredAt":
      default:
        return usageRecords.occurredAt;
    }
  })() as SQL;

  const cursorWhere = buildCursorWhere(sortField, sortOrder, cursor, sortExpr);
  if (cursorWhere) whereParts.push(cursorWhere);

  const where = whereParts.length ? and(...whereParts) : undefined;

  const rows = await db
    .select({
      id: usageRecords.id,
      occurredAt: usageRecords.occurredAt,
      route: usageRecords.route,
      model: usageRecords.model,
      totalTokens: usageRecords.totalTokens,
      inputTokens: usageRecords.inputTokens,
      outputTokens: usageRecords.outputTokens,
      reasoningTokens: usageRecords.reasoningTokens,
      cachedTokens: usageRecords.cachedTokens,
      totalRequests: usageRecords.totalRequests,
      successCount: usageRecords.successCount,
      failureCount: usageRecords.failureCount,
      isError: usageRecords.isError,
      cost: COST_EXPR
    })
    .from(usageRecords)
    .where(where)
    .orderBy(
      sortOrder === "asc" ? asc(sortExpr) : desc(sortExpr),
      sortOrder === "asc" ? asc(usageRecords.id) : desc(usageRecords.id)
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  const nextCursor = (() => {
    if (!hasMore) return null;
    const last = items[items.length - 1];
    if (!last) return null;
    const lastValue = (() => {
      switch (sortField) {
        case "model":
          return last.model;
        case "totalTokens":
          return last.totalTokens;
        case "cost":
          return Number(last.cost ?? 0);
        case "route":
          return last.route;
        case "inputTokens":
          return last.inputTokens;
        case "outputTokens":
          return last.outputTokens;
        case "reasoningTokens":
          return last.reasoningTokens;
        case "cachedTokens":
          return last.cachedTokens;
        case "isError":
          return last.isError ? 1 : 0;
        case "occurredAt":
        default:
          return last.occurredAt.toISOString();
      }
    })();
    const cursorPayload: UsageRecordCursor = { lastValue, lastId: last.id };
    return Buffer.from(JSON.stringify(cursorPayload)).toString("base64");
  })();

  let filters: { models: string[]; routes: string[] } | undefined;
  if (input.includeFilters) {
    const [modelRows, routeRows] = await Promise.all([
      db
        .select({ model: usageRecords.model })
        .from(usageRecords)
        .where(where)
        .groupBy(usageRecords.model)
        .orderBy(usageRecords.model)
        .limit(200),
      db
        .select({ route: usageRecords.route })
        .from(usageRecords)
        .where(where)
        .groupBy(usageRecords.route)
        .orderBy(usageRecords.route)
        .limit(200)
    ]);
    filters = { models: modelRows.map((row) => row.model), routes: routeRows.map((row) => row.route) };
  }

  return {
    items: items.map((row) => ({
      ...row,
      cost: Number(row.cost ?? 0)
    })),
    nextCursor,
    filters
  };
}