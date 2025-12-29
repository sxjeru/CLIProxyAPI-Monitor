import { ModelPrice, UsageOverview } from "@/lib/types";

export const defaultPrices: ModelPrice[] = [
  { model: "gpt-4o", inputPricePer1k: 2.5, outputPricePer1k: 5 },
  { model: "gpt-4o-mini", inputPricePer1k: 0.15, outputPricePer1k: 0.6 },
  { model: "claude-3.5-sonnet", inputPricePer1k: 3, outputPricePer1k: 15 }
];

const sample = {
  totalRequests: 482,
  successRate: 0.97,
  tokens: {
    total: 365_240,
    input: 214_980,
    output: 150_260
  },
  models: {
    "gpt-4o": { requests: 180, input: 95_000, output: 78_000 },
    "gpt-4o-mini": { requests: 220, input: 95_000, output: 50_000 },
    "claude-3.5-sonnet": { requests: 82, input: 24_980, output: 22_260 }
  },
  byDay: [
    { label: "Mon", requests: 60, tokens: 34_000 },
    { label: "Tue", requests: 78, tokens: 41_200 },
    { label: "Wed", requests: 88, tokens: 56_000 },
    { label: "Thu", requests: 96, tokens: 72_540 },
    { label: "Fri", requests: 102, tokens: 80_100 },
    { label: "Sat", requests: 42, tokens: 28_400 },
    { label: "Sun", requests: 16, tokens: 12_000 }
  ],
  byHour: [
    { label: "00", requests: 6, tokens: 3200 },
    { label: "04", requests: 12, tokens: 6400 },
    { label: "08", requests: 44, tokens: 21_000 },
    { label: "12", requests: 86, tokens: 64_000 },
    { label: "16", requests: 120, tokens: 90_000 },
    { label: "20", requests: 110, tokens: 82_000 },
    { label: "23", requests: 24, tokens: 12_640 }
  ]
};

export function getMockOverview(prices: ModelPrice[] = defaultPrices): UsageOverview {
  const models = Object.entries(sample.models).map(([model, stats]) => {
    const price = prices.find((p) => p.model === model);
    const inputCost = price ? (stats.input / 1000) * price.inputPricePer1k : 0;
    const outputCost = price ? (stats.output / 1000) * price.outputPricePer1k : 0;
    return {
      model,
      requests: stats.requests,
      tokens: stats.input + stats.output,
      inputTokens: stats.input,
      outputTokens: stats.output,
      cost: +(inputCost + outputCost).toFixed(2)
    };
  });

  const totalCost = models.reduce((acc, m) => acc + m.cost, 0);

  return {
    totalRequests: sample.totalRequests,
    totalTokens: sample.tokens.total,
    successRate: sample.successRate,
    totalCost: +totalCost.toFixed(2),
    models,
    byDay: sample.byDay,
    byHour: sample.byHour
  };
}
