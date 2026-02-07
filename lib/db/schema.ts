import { pgTable, serial, text, integer, timestamp, boolean, numeric, uniqueIndex } from "drizzle-orm/pg-core";

export const modelPrices = pgTable("model_prices", {
  id: serial("id").primaryKey(),
  model: text("model").notNull().unique(),
  inputPricePer1M: numeric("input_price_per_1m", { precision: 10, scale: 4 }).notNull(),
  cachedInputPricePer1M: numeric("cached_input_price_per_1m", { precision: 10, scale: 4 }).default("0").notNull(),
  outputPricePer1M: numeric("output_price_per_1m", { precision: 10, scale: 4 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const usageRecords = pgTable(
  "usage_records",
  {
    id: serial("id").primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    route: text("route").notNull(),
    model: text("model").notNull(),
    authIndex: text("auth_index"),
    channel: text("channel"),
    totalTokens: integer("total_tokens").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").default(0).notNull(),
    cachedTokens: integer("cached_tokens").default(0).notNull(),
    isError: boolean("is_error").notNull().default(false),
    raw: text("raw").notNull()
  },
  (table) => ({
    uniq: uniqueIndex("usage_records_occurred_route_model_idx").on(table.occurredAt, table.route, table.model)
  })
);
