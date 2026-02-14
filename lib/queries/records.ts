import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { authFileMappings, modelPrices, usageRecords } from "@/lib/db/schema";

export type UsageRecordRow = {
  id: number;
  occurredAt: Date;
  route: string;
  source: string;
  credentialName: string;
  provider: string | null;
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
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
  | "source"
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "reasoningTokens"
  | "cachedTokens"
  | "cost"
  | "isError";
type SortOrder = "asc" | "desc";

// 注意：必须使用 sql.raw() 来引用外部表字段，否则 Drizzle 会丢失表名前缀
// 反斜杠需要双重转义：JS 字符串转义 + PostgreSQL E'' 字符串转义
const COST_EXPR = sql<number>`coalesce(
  -- 尝试精确匹配
  (select (
    (greatest(${sql.raw('"usage_records"."input_tokens"')} - ${sql.raw('"usage_records"."cached_tokens"')}, 0)::numeric / 1000000) * mp.input_price_per_1m
    + (${sql.raw('"usage_records"."cached_tokens"')}::numeric / 1000000) * mp.cached_input_price_per_1m
    + ((${sql.raw('"usage_records"."output_tokens"')} + ${sql.raw('"usage_records"."reasoning_tokens"')})::numeric / 1000000) * mp.output_price_per_1m
  )
  from model_prices mp
  where mp.model = ${sql.raw('"usage_records"."model"')}
  limit 1),
  -- 如果精确匹配失败，尝试通配符匹配（按非通配符字符数量降序选择最具体的）
  (select (
    (greatest(${sql.raw('"usage_records"."input_tokens"')} - ${sql.raw('"usage_records"."cached_tokens"')}, 0)::numeric / 1000000) * mp.input_price_per_1m
    + (${sql.raw('"usage_records"."cached_tokens"')}::numeric / 1000000) * mp.cached_input_price_per_1m
    + ((${sql.raw('"usage_records"."output_tokens"')} + ${sql.raw('"usage_records"."reasoning_tokens"')})::numeric / 1000000) * mp.output_price_per_1m
  )
  from model_prices mp
  where mp.model like '%*%'
    and ${sql.raw('"usage_records"."model"')} ~ (
      '^' ||
      regexp_replace(
        regexp_replace(
          mp.model,
          E'([.+?^$()\\\\[\\\\]{}|\\\\\\\\-])',
          E'\\\\\\\\\\\\1',
          'g'
        ),
        E'\\\\*',
        '.*',
        'g'
      )
      || '$'
    )
  order by length(replace(mp.model, '*', '')) desc, length(mp.model) desc
  limit 1),
  -- 如果都没匹配，返回 0
  0
)`;

const CREDENTIAL_NAME_EXPR = sql<string>`coalesce(nullif(${authFileMappings.name}, ''), nullif(${usageRecords.source}, ''), '-')`;

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
  source?: string | null;
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

  if (input.source) {
    whereParts.push(sql`${CREDENTIAL_NAME_EXPR} = ${input.source}`);
  }

  const sortExpr = (() => {
    switch (sortField) {
      case "model":
        return usageRecords.model;
      case "route":
        return usageRecords.route;
      case "source":
        return CREDENTIAL_NAME_EXPR;
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

  const query = db
    .select({
      id: usageRecords.id,
      occurredAt: usageRecords.occurredAt,
      route: usageRecords.route,
      source: usageRecords.source,
      credentialName: CREDENTIAL_NAME_EXPR,
      provider: authFileMappings.provider,
      model: usageRecords.model,
      totalTokens: usageRecords.totalTokens,
      inputTokens: usageRecords.inputTokens,
      outputTokens: usageRecords.outputTokens,
      reasoningTokens: usageRecords.reasoningTokens,
      cachedTokens: usageRecords.cachedTokens,
      isError: usageRecords.isError,
      cost: COST_EXPR
    })
    .from(usageRecords)
    .leftJoin(authFileMappings, eq(usageRecords.authIndex, authFileMappings.authId))
    .where(where)
    .orderBy(
      sortOrder === "asc" ? asc(sortExpr) : desc(sortExpr),
      sortOrder === "asc" ? asc(usageRecords.id) : desc(usageRecords.id)
    )
    .limit(limit + 1);

  const rows = await query;

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
        case "source":
          return last.credentialName;
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

  let filters: { models: string[]; routes: string[]; sources: string[] } | undefined;
  if (input.includeFilters) {
    const [modelRows, routeRows, sourceRows] = await Promise.all([
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
        .limit(200),
      db
        .select({ source: CREDENTIAL_NAME_EXPR })
        .from(usageRecords)
        .leftJoin(authFileMappings, eq(usageRecords.authIndex, authFileMappings.authId))
        .where(where)
        .groupBy(CREDENTIAL_NAME_EXPR)
        .orderBy(CREDENTIAL_NAME_EXPR)
        .limit(200),
    ]);
    filters = {
      models: modelRows.map((row) => row.model),
      routes: routeRows.map((row) => row.route),
      sources: sourceRows.map((row) => row.source).filter((name): name is string => Boolean(name) && name !== "-")
    };
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