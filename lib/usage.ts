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
  // auth_index is a hex string (16 characters from SHA-256 hash)
  auth_index: z
    .preprocess((value) => {
      if (value === undefined || value === null) return undefined;
      return String(value);
    }, z.string().optional()),
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
  total_tokens: z.number().optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cached_tokens: z.number().optional(),
  details: z.array(detailSchema).optional()
});

const apiSchema = z.object({
  total_tokens: z.number().optional(),
  models: z.record(z.string(), modelSchema).optional()
});

const usageSchema = z.object({
  total_tokens: z.number().optional(),
  requests_by_day: z.record(z.string(), z.number()).optional(),
  requests_by_hour: z.record(z.string(), z.number()).optional(),
  tokens_by_day: z.record(z.string(), z.number()).optional(),
  tokens_by_hour: z.record(z.string(), z.number()).optional(),
  apis: z.record(z.string(), apiSchema).optional()
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

export function toUsageRecords(
  payload: UsageResponse,
  pulledAt: Date = new Date(),
  authMap?: Map<string, string>,
  apiKeyMap?: Map<string, string>
): UsageRecordInsert[] {
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
          const authIdx = detail.auth_index ?? undefined;
          const source = detail.source ?? undefined;
          let channel: string | undefined = authIdx && authMap?.get(authIdx)
            ? authMap.get(authIdx)
            : undefined;
          if (!channel && source && apiKeyMap?.get(source)) {
            channel = apiKeyMap.get(source);
          }
          if (!channel) {
            channel = authIdx;
          }

          rows.push({
            occurredAt,
            syncedAt: pulledAt,
            route,
            model,
            authIndex: authIdx ?? null,
            channel: channel ?? null,
            totalTokens: tokenSlice.totalTokens,
            inputTokens: tokenSlice.inputTokens,
            outputTokens: tokenSlice.outputTokens,
            reasoningTokens: tokenSlice.reasoningTokens,
            cachedTokens: tokenSlice.cachedTokens,
            isError: !success,
            raw: JSON.stringify({ route, model, detail })
          });
        }
        continue;
      }
    }
  }

  return rows;
}

type PriceEntry = { model: string; inputPricePer1M: number; cachedInputPricePer1M: number; outputPricePer1M: number };
type PriceInfo = { in: number; cachedIn: number; out: number };

export function priceMap(prices: PriceEntry[]) {
  // 分离精确匹配和通配符模式
  const exact: Record<string, PriceInfo> = {};
  const patterns: { regex: RegExp; price: PriceInfo; original: string }[] = [];
  
  for (const cur of prices) {
    const price: PriceInfo = { in: cur.inputPricePer1M, cachedIn: cur.cachedInputPricePer1M, out: cur.outputPricePer1M };
    if (cur.model.includes("*")) {
      // 转换通配符为正则：* -> .* 
      const regexStr = "^" + cur.model.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
      patterns.push({ regex: new RegExp(regexStr), price, original: cur.model });
    } else {
      exact[cur.model] = price;
    }
  }
  
  // 按非通配符字符数量降序排序，优先匹配更具体的模式（与 SQL 逻辑保持一致）
  patterns.sort((a, b) => {
    const aSpecificity = a.original.replace(/\*/g, "").length;
    const bSpecificity = b.original.replace(/\*/g, "").length;
    return bSpecificity - aSpecificity || b.original.length - a.original.length;
  });
  
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
  tokens: { inputTokens: number; cachedTokens?: number; outputTokens: number; reasoningTokens?: number },
  model: string,
  prices: ReturnType<typeof priceMap>
) {
  const priceInfo = findPrice(model, prices);
  if (!priceInfo) return 0;
  // 价格单位是 $/M tokens，所以除以 1_000_000
  const cachedTokens = tokens.cachedTokens ?? 0;
  const reasoningTokens = tokens.reasoningTokens ?? 0;
  const regularInputTokens = Math.max(0, tokens.inputTokens - cachedTokens);
  const inputCost = (regularInputTokens / 1_000_000) * priceInfo.in;
  const cachedCost = (cachedTokens / 1_000_000) * priceInfo.cachedIn;
  const outputCost = ((tokens.outputTokens + reasoningTokens) / 1_000_000) * priceInfo.out;
  return Number((inputCost + cachedCost + outputCost).toFixed(6));
}
