import { NextResponse } from "next/server";
import { and, sql, gte, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { usageRecords, modelPrices } from "@/lib/db/schema";
import { estimateCost, priceMap } from "@/lib/usage";

type ChannelAggRow = {
  channel: string | null;
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  errorCount: number;
};

type ChannelModelAggRow = {
  channel: string | null;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
};

type PriceRow = typeof modelPrices.$inferSelect;

function toNumber(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");
  const daysParam = searchParams.get("days");

  const startDate = parseDateInput(startParam);
  const endDate = parseDateInput(endParam);
  const hasCustomRange = startDate && endDate && endDate >= startDate;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const days = hasCustomRange 
    ? Math.max(1, Math.round((withDayEnd(endDate).getTime() - withDayStart(startDate).getTime()) / DAY_MS) + 1)
    : Math.min(Math.max(Math.floor(Number(daysParam) || 14), 1), 90);

  const since = hasCustomRange ? withDayStart(startDate!) : new Date(Date.now() - days * DAY_MS);
  const until = hasCustomRange ? withDayEnd(endDate!) : undefined;

  const whereParts: SQL[] = [gte(usageRecords.occurredAt, since)];
  if (until) whereParts.push(lte(usageRecords.occurredAt, until));
  const whereClause = whereParts.length ? and(...whereParts) : undefined;

  try {
    // Fetch aggregated channel statistics
    const channelAggRows: ChannelAggRow[] = await db
      .select({
        channel: usageRecords.channel,
        requests: sql<number>`count(*)`,
        tokens: sql<number>`sum(${usageRecords.totalTokens})`,
        inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
        outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
        reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`,
        errorCount: sql<number>`sum(case when ${usageRecords.isError} then 1 else 0 end)`
      })
      .from(usageRecords)
      .where(whereClause)
      .groupBy(usageRecords.channel)
      .orderBy(sql`count(*) desc`);

    // Fetch channel-model breakdown for cost calculation
    const channelModelAggRows: ChannelModelAggRow[] = await db
      .select({
        channel: usageRecords.channel,
        model: usageRecords.model,
        requests: sql<number>`count(*)`,
        inputTokens: sql<number>`sum(${usageRecords.inputTokens})`,
        outputTokens: sql<number>`sum(${usageRecords.outputTokens})`,
        reasoningTokens: sql<number>`coalesce(sum(${usageRecords.reasoningTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${usageRecords.cachedTokens}), 0)`
      })
      .from(usageRecords)
      .where(whereClause)
      .groupBy(usageRecords.channel, usageRecords.model);

    // Fetch pricing information
    const priceRows: PriceRow[] = await db.select().from(modelPrices);
    const prices = priceMap(
      priceRows.map((p: PriceRow) => ({
        model: p.model,
        inputPricePer1M: Number(p.inputPricePer1M),
        cachedInputPricePer1M: Number(p.cachedInputPricePer1M),
        outputPricePer1M: Number(p.outputPricePer1M)
      }))
    );

    // Calculate costs per channel
    const channelCostMap = new Map<string, number>();
    for (const row of channelModelAggRows) {
      const channelKey = row.channel ?? "未知渠道";
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
      channelCostMap.set(channelKey, (channelCostMap.get(channelKey) ?? 0) + cost);
    }

    // Build response
    const channels = channelAggRows.map((row) => {
      const channelKey = row.channel ?? "未知渠道";
      return {
        channel: channelKey,
        requests: toNumber(row.requests),
        totalTokens: toNumber(row.tokens),
        inputTokens: toNumber(row.inputTokens),
        outputTokens: toNumber(row.outputTokens),
        reasoningTokens: toNumber(row.reasoningTokens),
        cachedTokens: toNumber(row.cachedTokens),
        errorCount: toNumber(row.errorCount),
        cost: Number((channelCostMap.get(channelKey) ?? 0).toFixed(4))
      };
    });

    return NextResponse.json({ channels, days });
  } catch (error) {
    console.error("Error fetching channel statistics:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
