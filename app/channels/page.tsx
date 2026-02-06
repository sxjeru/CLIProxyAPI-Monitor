"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { formatCurrency, formatNumberWithCommas } from "@/lib/utils";
import { Activity, RefreshCw, ChevronDown, ChevronRight, Key, Users } from "lucide-react";

type ChannelStat = {
  channel: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  errorCount: number;
  cost: number;
};

type ChannelAPIResponse = {
  channels: ChannelStat[];
  days: number;
};

type ChannelGroup = {
  name: string;
  type: "auth" | "apikey";
  channels: ChannelStat[];
  total: Omit<ChannelStat, "channel">;
};

function aggregateStats(channels: ChannelStat[]): Omit<ChannelStat, "channel"> {
  return channels.reduce(
    (acc, ch) => ({
      requests: acc.requests + ch.requests,
      totalTokens: acc.totalTokens + ch.totalTokens,
      inputTokens: acc.inputTokens + ch.inputTokens,
      outputTokens: acc.outputTokens + ch.outputTokens,
      reasoningTokens: acc.reasoningTokens + ch.reasoningTokens,
      cachedTokens: acc.cachedTokens + ch.cachedTokens,
      errorCount: acc.errorCount + ch.errorCount,
      cost: acc.cost + ch.cost
    }),
    { requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, errorCount: 0, cost: 0 }
  );
}

function groupChannels(channels: ChannelStat[]): ChannelGroup[] {
  const authGroups = new Map<string, ChannelStat[]>();
  const apiKeyChannels: ChannelStat[] = [];

  for (const ch of channels) {
    const name = ch.channel;
    const slashIdx = name.indexOf("/");
    const looksLikeUrl = name.startsWith("http://") || name.startsWith("https://");
    const looksLikeHex = /^[0-9a-f]{8,}$/i.test(name);

    if (slashIdx > 0 && !looksLikeUrl && !looksLikeHex) {
      const provider = name.slice(0, slashIdx);
      const existing = authGroups.get(provider) || [];
      existing.push(ch);
      authGroups.set(provider, existing);
    } else {
      apiKeyChannels.push(ch);
    }
  }

  const groups: ChannelGroup[] = [];

  const authEntries = [...authGroups.entries()]
    .map(([name, chs]) => ({ name, channels: chs, total: aggregateStats(chs) }))
    .sort((a, b) => b.total.requests - a.total.requests);

  for (const entry of authEntries) {
    groups.push({ name: entry.name, type: "auth", channels: entry.channels, total: entry.total });
  }

  for (const ch of apiKeyChannels) {
    groups.push({
      name: ch.channel,
      type: "apikey",
      channels: [ch],
      total: { requests: ch.requests, totalTokens: ch.totalTokens, inputTokens: ch.inputTokens, outputTokens: ch.outputTokens, reasoningTokens: ch.reasoningTokens, cachedTokens: ch.cachedTokens, errorCount: ch.errorCount, cost: ch.cost }
    });
  }

  return groups;
}

function fmtRate(requests: number, errorCount: number): string {
  if (requests === 0) return "-";
  const rate = ((requests - errorCount) / requests) * 100;
  if (rate === 100) return "100%";
  return rate.toFixed(1) + "%";
}

function rateColor(requests: number, errorCount: number): string {
  if (requests === 0) return "text-slate-500";
  const rate = ((requests - errorCount) / requests) * 100;
  if (rate >= 99) return "text-emerald-400";
  if (rate >= 95) return "text-amber-400";
  return "text-red-400";
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 bg-slate-800/50 ring-slate-700 hover:shadow-lg hover:shadow-slate-700/30 hover:ring-slate-600">
      <div className="text-sm uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-3 text-2xl font-semibold ${color || "text-white"}`}>
        {value}
      </div>
    </div>
  );
}

function TokenBar({ input, output, reasoning, cached, total }: { input: number; output: number; reasoning: number; cached: number; total: number }) {
  if (total === 0) return null;
  const segments = [
    { value: input - cached, color: "bg-rose-400", label: "输入" },
    { value: cached, color: "bg-purple-400", label: "缓存" },
    { value: output, color: "bg-emerald-400", label: "输出" },
    { value: reasoning, color: "bg-amber-400", label: "思考" },
  ].filter(s => s.value > 0);

  return (
    <div className="mt-1.5 mx-5 flex h-1.5 overflow-hidden rounded-full bg-slate-700/50">
      {segments.map((seg, i) => (
        <div
          key={i}
          className={`${seg.color} transition-all duration-300`}
          style={{ width: `${(seg.value / total) * 100}%` }}
          title={`${seg.label}: ${formatNumberWithCommas(seg.value)}`}
        />
      ))}
    </div>
  );
}

function TokenLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-rose-400" />输入</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-purple-400" />缓存</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />输出</span>
      <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" />思考</span>
    </div>
  );
}

/* Fixed column widths for alignment across all rows */
const COL = {
  arrow: "w-5 shrink-0",
  icon: "w-9 shrink-0",
  requests: "w-[72px] text-right shrink-0",
  tokens: "w-[90px] text-right shrink-0",
  cost: "w-[80px] text-right shrink-0",
  rate: "w-[56px] text-right shrink-0",
};

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"requests" | "totalTokens" | "cost">("requests");

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/channels?days=${days}`);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      const data: ChannelAPIResponse = await response.json();
      setChannels(data.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const toggleGroup = (name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const groups = useMemo(() => {
    const g = groupChannels(channels);
    return g.sort((a, b) => b.total[sortBy] - a.total[sortBy]);
  }, [channels, sortBy]);

  const totalStats = useMemo(() => aggregateStats(channels), [channels]);

  return (
    <main className="min-h-screen px-3 sm:px-6 py-6 sm:py-8 bg-slate-900 text-slate-100">
      {/* Header */}
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Activity className="h-6 w-6" />
            渠道统计
          </h1>
          <p className="text-base text-slate-400">按认证渠道查看用量和费用统计</p>
        </div>
        <button
          onClick={fetchChannels}
          disabled={loading}
          className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
            loading
              ? "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-500"
              : "border-indigo-500/50 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30"
          }`}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "加载中..." : "刷新数据"}
        </button>
      </header>

      {/* Time Range */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="text-sm uppercase tracking-wide text-slate-500">时间范围</span>
        {[1, 7, 14, 30, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              days === d
                ? "border-indigo-500 bg-indigo-600 text-white"
                : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"
            }`}
          >
            {d === 1 ? "今天" : `${d} 天`}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <div>
            <p className="font-semibold">加载失败</p>
            <p className="text-red-300">{error}</p>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      <section className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {loading ? (
          <>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-28 rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 animate-pulse" />
            ))}
          </>
        ) : (
          <>
            <StatCard label="总请求" value={formatNumberWithCommas(totalStats.requests)} />
            <StatCard label="总 Tokens" value={formatNumberWithCommas(totalStats.totalTokens)} />
            <StatCard
              label="成功率"
              value={fmtRate(totalStats.requests, totalStats.errorCount)}
              color={rateColor(totalStats.requests, totalStats.errorCount)}
            />
            <div className="rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 bg-gradient-to-br from-amber-500/20 to-amber-700/10 ring-amber-400/40 hover:shadow-lg hover:shadow-amber-500/20 hover:ring-amber-400/60">
              <div className="text-sm uppercase tracking-wide text-amber-400">总费用</div>
              <div className="mt-3 text-2xl font-semibold text-white">{formatCurrency(totalStats.cost)}</div>
            </div>
          </>
        )}
      </section>

      {/* Sort Options + Token Legend */}
      {!loading && channels.length > 0 && (
        <div className="mt-6 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">排序</span>
            {([["requests", "请求数"], ["totalTokens", "Token"], ["cost", "费用"]] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  sortBy === key
                    ? "border-indigo-500 bg-indigo-600/20 text-indigo-400"
                    : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <TokenLegend />
        </div>
      )}

      {/* Column Headers */}
      {!loading && channels.length > 0 && (
        <div className="mt-4 hidden sm:flex items-center gap-3 px-5 py-1 text-xs uppercase tracking-wide text-slate-500">
          <div className={COL.arrow} />
          <div className={COL.icon} />
          <div className="flex-1 min-w-0" />
          <div className="flex items-center gap-3">
            <div className={COL.requests}>请求</div>
            <div className={COL.tokens}>Tokens</div>
            <div className={COL.cost}>费用</div>
            <div className={COL.rate}>成功率</div>
          </div>
        </div>
      )}

      {/* Channel Groups */}
      <section className="mt-1 space-y-2">
        {loading ? (
          <div className="rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 p-12 text-center">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto text-indigo-400" />
            <p className="text-slate-400 mt-3">加载中...</p>
          </div>
        ) : channels.length === 0 ? (
          <div className="rounded-2xl bg-slate-800/50 ring-1 ring-slate-700 p-12 text-center">
            <p className="text-slate-400">暂无数据</p>
          </div>
        ) : (
          groups.map((group) => {
            const isAuth = group.type === "auth";
            const isExpanded = expandedGroups.has(group.name);
            const hasMultiple = group.channels.length > 1;
            const canExpand = isAuth && hasMultiple;

            return (
              <div
                key={group.name}
                className="rounded-2xl ring-1 ring-slate-700 bg-slate-800/50 overflow-hidden transition-all duration-200 hover:ring-slate-600"
              >
                {/* Group Header */}
                <div
                  className={`flex items-center gap-3 px-5 py-3.5 ${canExpand ? "cursor-pointer hover:bg-slate-700/30" : ""}`}
                  onClick={() => canExpand && toggleGroup(group.name)}
                >
                  {/* Arrow - always occupies space for alignment */}
                  <div className={COL.arrow}>
                    {canExpand && (
                      isExpanded
                        ? <ChevronDown className="h-4 w-4 text-slate-500" />
                        : <ChevronRight className="h-4 w-4 text-slate-500" />
                    )}
                  </div>

                  {/* Icon */}
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    isAuth
                      ? "bg-indigo-500/20 text-indigo-400"
                      : "bg-emerald-500/20 text-emerald-400"
                  }`}>
                    {isAuth ? <Users className="h-4 w-4" /> : <Key className="h-4 w-4" />}
                  </div>

                  {/* Name & Badge & Token Bar */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-white truncate">{group.name}</span>
                      {canExpand && (
                        <span className="shrink-0 rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-medium text-indigo-400">
                          {group.channels.length} 账号
                        </span>
                      )}
                    </div>
                    <TokenBar
                      input={group.total.inputTokens}
                      output={group.total.outputTokens}
                      reasoning={group.total.reasoningTokens}
                      cached={group.total.cachedTokens}
                      total={group.total.totalTokens}
                    />
                  </div>

                  {/* Stats - Desktop */}
                  <div className="hidden sm:flex items-center gap-3 text-sm">
                    <div className={COL.requests}>
                      <div className="text-white font-medium">{formatNumberWithCommas(group.total.requests)}</div>
                    </div>
                    <div className={COL.tokens}>
                      <div className="text-white font-medium">{formatNumberWithCommas(group.total.totalTokens)}</div>
                    </div>
                    <div className={COL.cost}>
                      <div className="text-amber-400 font-medium">{formatCurrency(group.total.cost)}</div>
                    </div>
                    <div className={COL.rate}>
                      <div className={`font-medium ${rateColor(group.total.requests, group.total.errorCount)}`}>
                        {fmtRate(group.total.requests, group.total.errorCount)}
                      </div>
                    </div>
                  </div>

                  {/* Stats - Mobile */}
                  <div className="sm:hidden text-right text-sm shrink-0">
                    <div className="text-white font-medium">{formatNumberWithCommas(group.total.requests)} 次</div>
                    <div className="text-amber-400 text-xs">{formatCurrency(group.total.cost)}</div>
                  </div>
                </div>

                {/* Expanded Sub-channels */}
                {canExpand && isExpanded && (
                  <div className="border-t border-slate-700/50">
                    {group.channels
                      .sort((a, b) => b.requests - a.requests)
                      .map((ch, idx) => {
                        const accountName = ch.channel.includes("/")
                          ? ch.channel.slice(ch.channel.indexOf("/") + 1)
                          : ch.channel;
                        return (
                          <div
                            key={idx}
                            className={`flex items-center gap-3 px-5 py-2.5 ${
                              idx < group.channels.length - 1 ? "border-b border-slate-700/30" : ""
                            } hover:bg-slate-700/20 transition-colors`}
                          >
                            {/* Arrow placeholder */}
                            <div className={COL.arrow} />
                            {/* Icon placeholder */}
                            <div className={COL.icon} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm text-slate-300 truncate block">{accountName}</span>
                              <TokenBar
                                input={ch.inputTokens}
                                output={ch.outputTokens}
                                reasoning={ch.reasoningTokens}
                                cached={ch.cachedTokens}
                                total={ch.totalTokens}
                              />
                            </div>
                            {/* Stats - Desktop */}
                            <div className="hidden sm:flex items-center gap-3 text-sm">
                              <div className={COL.requests}>
                                <div className="text-slate-300">{formatNumberWithCommas(ch.requests)}</div>
                              </div>
                              <div className={COL.tokens}>
                                <div className="text-slate-300">{formatNumberWithCommas(ch.totalTokens)}</div>
                              </div>
                              <div className={COL.cost}>
                                <div className="text-amber-400/80">{formatCurrency(ch.cost)}</div>
                              </div>
                              <div className={COL.rate}>
                                <div className={rateColor(ch.requests, ch.errorCount)}>
                                  {fmtRate(ch.requests, ch.errorCount)}
                                </div>
                              </div>
                            </div>
                            {/* Stats - Mobile */}
                            <div className="sm:hidden text-right text-xs shrink-0">
                              <div className="text-slate-300">{formatNumberWithCommas(ch.requests)} 次</div>
                              <div className="text-amber-400/80">{formatCurrency(ch.cost)}</div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}
