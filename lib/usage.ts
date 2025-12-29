import { z } from "zod";
import { usageRecords } from "@/lib/db/schema";

// 上游 API 的 tokens 对象结构
const tokensSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  cached_tokens: z.number().optional(),
  total_tokens: z.number().optional()
});

const detailSchema = z.object({
  timestamp: z.string().optional(),
  source: z.string().optional(),
  auth_index: z.number().optional(),
  tokens: tokensSchema.optional(),
  failed: z.boolean().optional(),
  // 兼容旧格式
  total_tokens: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cached_tokens: z.number().optional(),
  success: z.boolean().optional()
});

const modelSchema = z.object({
  total_requests: z.number().optional(),
  total_tokens: z.number().optional(),
  success_count: z.number().optional(),
  failure_count: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cached_tokens: z.number().optional(),
  details: z.array(detailSchema).optional()
});

const apiSchema = z.object({
  total_requests: z.number().optional(),
  total_tokens: z.number().optional(),
  success_count: z.number().optional(),
  failure_count: z.number().optional(),
  models: z.record(modelSchema).optional()
});

const usageSchema = z.object({
  total_requests: z.number().optional(),
  success_count: z.number().optional(),
  failure_count: z.number().optional(),
  total_tokens: z.number().optional(),
  requests_by_day: z.record(z.number()).optional(),
  requests_by_hour: z.record(z.number()).optional(),
  tokens_by_day: z.record(z.number()).optional(),
  tokens_by_hour: z.record(z.number()).optional(),
  apis: z.record(apiSchema).optional()
});

const responseSchema = z.object({ usage: usageSchema.optional() });

export type UsageResponse = z.infer<typeof responseSchema>;
export type UsageRecordInsert = typeof usageRecords.$inferInsert;
type ApiParsed = z.infer<typeof apiSchema>;
type ModelParsed = z.infer<typeof modelSchema>;

function parseDetailTokens(detail: z.infer<typeof detailSchema>) {
  const tokens = detail.tokens;
  return {
    totalTokens: tokens?.total_tokens ?? detail.total_tokens ?? 0,
    inputTokens: tokens?.input_tokens ?? detail.input_tokens ?? 0,
    outputTokens: tokens?.output_tokens ?? detail.output_tokens ?? 0,
    reasoningTokens: tokens?.reasoning_tokens ?? 0,
    cachedTokens: tokens?.cached_tokens ?? detail.cached_tokens ?? 0
  };
}

function parseDetailTimestamp(detail: z.infer<typeof detailSchema>, fallback: Date) {
  if (!detail.timestamp) return fallback;
  const date = new Date(detail.timestamp);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function isDetailSuccess(detail: z.infer<typeof detailSchema>) {
  // failed=true 表示失败，success=false 表示失败，其余视为成功
  if (detail.failed === true) return false;
  if (detail.success === false) return false;
  return true;
}

export function parseUsagePayload(json: unknown): UsageResponse {
  return responseSchema.parse(json);
}

export function toUsageRecords(payload: UsageResponse, pulledAt: Date = new Date()): UsageRecordInsert[] {
  const apis = payload.usage?.apis as Record<string, ApiParsed> | undefined;
  if (!apis) return [];

  const rows: UsageRecordInsert[] = [];

  for (const [route, api] of Object.entries(apis)) {
    const models = (api as ApiParsed).models ?? {};
    for (const [model, stats] of Object.entries(models)) {
      const typed = stats as ModelParsed;
      const details = typed.details ?? [];

      if (details.length > 0) {
        for (const detail of details) {
          const tokenSlice = parseDetailTokens(detail);
          const occurredAt = parseDetailTimestamp(detail, pulledAt);
          const success = isDetailSuccess(detail);

          rows.push({
            occurredAt,
            syncedAt: pulledAt,
            route,
            model,
            totalTokens: tokenSlice.totalTokens,
            inputTokens: tokenSlice.inputTokens,
            outputTokens: tokenSlice.outputTokens,
            reasoningTokens: tokenSlice.reasoningTokens,
            cachedTokens: tokenSlice.cachedTokens,
            totalRequests: 1,
            successCount: success ? 1 : 0,
            failureCount: success ? 0 : 1,
            isError: !success,
            raw: JSON.stringify({ route, model, detail })
          });
        }
        continue;
      }

      const totalRequests = typed.total_requests ?? 0;
      const failureCount = typed.failure_count ?? 0;
      const successCount = typed.success_count ?? Math.max(totalRequests - failureCount, 0);

      rows.push({
        occurredAt: pulledAt,
        syncedAt: pulledAt,
        route,
        model,
        totalTokens: typed.total_tokens ?? 0,
        inputTokens: typed.input_tokens ?? 0,
        outputTokens: typed.output_tokens ?? 0,
        reasoningTokens: 0,
        cachedTokens: typed.cached_tokens ?? 0,
        totalRequests,
        successCount,
        failureCount,
        isError: failureCount > 0,
        raw: JSON.stringify({ route, model, stats })
      });
    }
  }

  return rows;
}

type PriceEntry = { model: string; inputPricePer1M: number; cachedInputPricePer1M: number; outputPricePer1M: number };
type PriceInfo = { in: number; cachedIn: number; out: number };

export function priceMap(prices: PriceEntry[]) {
  // 分离精确匹配和通配符模式
  const exact: Record<string, PriceInfo> = {};
  const patterns: { regex: RegExp; price: PriceInfo }[] = [];
  
  for (const cur of prices) {
    const price: PriceInfo = { in: cur.inputPricePer1M, cachedIn: cur.cachedInputPricePer1M, out: cur.outputPricePer1M };
    if (cur.model.includes("*")) {
      // 转换通配符为正则：* -> .* 
      const regexStr = "^" + cur.model.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
      patterns.push({ regex: new RegExp(regexStr), price });
    } else {
      exact[cur.model] = price;
    }
  }
  
  return { exact, patterns };
}

export function findPrice(model: string, prices: ReturnType<typeof priceMap>): PriceInfo | undefined {
  // 精确匹配优先
  if (prices.exact[model]) return prices.exact[model];
  // 尝试通配符匹配
  for (const { regex, price } of prices.patterns) {
    if (regex.test(model)) return price;
  }
  return undefined;
}

export function estimateCost(
  tokens: { inputTokens: number; cachedTokens?: number; outputTokens: number },
  model: string,
  prices: ReturnType<typeof priceMap>
) {
  const priceInfo = findPrice(model, prices);
  if (!priceInfo) return 0;
  // 价格单位是 $/M tokens，所以除以 1_000_000
  const cachedTokens = tokens.cachedTokens ?? 0;
  const regularInputTokens = Math.max(0, tokens.inputTokens - cachedTokens);
  const inputCost = (regularInputTokens / 1_000_000) * priceInfo.in;
  const cachedCost = (cachedTokens / 1_000_000) * priceInfo.cachedIn;
  const outputCost = (tokens.outputTokens / 1_000_000) * priceInfo.out;
  return Number((inputCost + cachedCost + outputCost).toFixed(6));
}
