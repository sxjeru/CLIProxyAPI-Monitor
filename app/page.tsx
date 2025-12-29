"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type FormEvent } from "react";
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar, Legend, ComposedChart, PieChart, Pie, Cell } from "recharts";
import { formatCurrency, formatNumber, formatCompactNumber, formatNumberWithCommas, formatHourLabel } from "@/lib/utils";
import { AlertTriangle, Info, LucideIcon, Activity, Save, RefreshCw, Moon, Sun, Pencil, Trash2, X, Maximize2 } from "lucide-react";
import type { ModelPrice, UsageOverview, UsageSeriesPoint } from "@/lib/types";

// 饼图颜色 - 柔和配色
const PIE_COLORS = ["#60a5fa", "#4ade80", "#fbbf24", "#c084fc", "#f472b6", "#38bdf8", "#a3e635", "#fb923c"];

type OverviewMeta = { page: number; pageSize: number; totalModels: number; totalPages: number };
type OverviewAPIResponse = { overview: UsageOverview | null; empty: boolean; days: number; meta?: OverviewMeta; filters?: { models: string[]; routes: string[] } };

type PriceForm = {
  model: string;
  inputPricePer1M: string;
  cachedInputPricePer1M: string;
  outputPricePer1M: string;
};

const hourFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false
});

const HOUR_MS = 60 * 60 * 1000;

function formatHourKeyFromTs(ts: number) {
  const parts = hourFormatter.formatToParts(new Date(ts));
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  const day = parts.find((p) => p.type === "day")?.value ?? "00";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  return `${month}-${day} ${hour}`;
}

function buildHourlySeries(series: UsageSeriesPoint[], rangeHours?: number) {
  if (!series.length) return [] as UsageSeriesPoint[];

  const withTs = series
    .map((point) => ({ ...point, ts: point.timestamp ? new Date(point.timestamp).getTime() : Number.NaN }))
    .filter((point) => Number.isFinite(point.ts))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  if (!withTs.length) return series;
  if (!rangeHours) return withTs.map(({ ts, ...rest }) => rest);

  const end = withTs[withTs.length - 1].ts as number;
  const start = end - (rangeHours - 1) * HOUR_MS;
  const bucket = new Map<number, UsageSeriesPoint & { ts: number }>();
  withTs.forEach((point) => bucket.set(point.ts as number, point as UsageSeriesPoint & { ts: number }));

  const filled: UsageSeriesPoint[] = [];
  for (let ts = start; ts <= end; ts += HOUR_MS) {
    const existing = bucket.get(ts);
    if (existing) {
      const { ts: _, ...rest } = existing;
      filled.push(rest);
    } else {
      filled.push({
        label: formatHourKeyFromTs(ts),
        timestamp: new Date(ts).toISOString(),
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0
      });
    }
  }

  return filled;
}

export default function DashboardPage() {
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewEmpty, setOverviewEmpty] = useState(false);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [rangeDays, setRangeDays] = useState(14);
  const [hourRange, setHourRange] = useState<"all" | "12h" | "24h">("all");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [routeOptions, setRouteOptions] = useState<string[]>([]);
  const [filterModelInput, setFilterModelInput] = useState("");
  const [filterRouteInput, setFilterRouteInput] = useState("");
  const [filterModel, setFilterModel] = useState<string | undefined>(undefined);
  const [filterRoute, setFilterRoute] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<PriceForm>({ model: "", inputPricePer1M: "", cachedInputPricePer1M: "", outputPricePer1M: "" });
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [ready, setReady] = useState(false);
  const [pieMode, setPieMode] = useState<"tokens" | "requests">("tokens");
  const [darkMode, setDarkMode] = useState(true);
  const [editingPrice, setEditingPrice] = useState<ModelPrice | null>(null);
  const [editForm, setEditForm] = useState<PriceForm>({ model: "", inputPricePer1M: "", cachedInputPricePer1M: "", outputPricePer1M: "" });
  const [fullscreenChart, setFullscreenChart] = useState<"trend" | "pie" | "stacked" | null>(null);
  const syncingRef = useRef(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // 执行数据同步
  const doSync = useCallback(async (showMessage = true, triggerRefresh = true) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncStatus(null);
    try {
      const res = await fetch("/api/sync", { method: "POST", cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        if (showMessage) setSyncStatus(`同步失败: ${data.error || res.statusText}`);
      } else {
        setLastSyncTime(new Date());
        if (showMessage) setSyncStatus(`已同步 ${data.inserted ?? 0} 条记录`);
        if (triggerRefresh) setRefreshTrigger((prev) => prev + 1);
      }
    } catch (err) {
      if (showMessage) setSyncStatus(`同步失败: ${(err as Error).message}`);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // 页面加载时自动同步一次
  useEffect(() => {
    let active = true;
    doSync(false, false).finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [doSync]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/prices", { cache: "no-store" });
        if (!res.ok) return;
        const data: ModelPrice[] = await res.json();
        setPrices(
          data.map((p) => ({
            model: p.model,
            inputPricePer1M: Number(p.inputPricePer1M),
            cachedInputPricePer1M: Number(p.cachedInputPricePer1M),
            outputPricePer1M: Number(p.outputPricePer1M)
          }))
        );
      } catch (err) {
        console.warn("Failed to load prices", err);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (!ready) return;

    const loadOverview = async () => {
      setLoadingOverview(true);
      try {
        const params = new URLSearchParams();
        params.set("days", String(rangeDays));
        if (filterModel) params.set("model", filterModel);
        if (filterRoute) params.set("route", filterRoute);
        params.set("page", String(page));
        params.set("pageSize", "500");

        const res = await fetch(`/api/overview?${params.toString()}`, { cache: "no-store" });

        if (!res.ok) {
          setOverviewError("无法加载实时用量：" + res.statusText);
          setOverview(null);
          return;
        }
        const data: OverviewAPIResponse = await res.json();
        setOverview(data.overview ?? null);
        setOverviewEmpty(Boolean(data.empty));
        setOverviewError(null);
        setPage(data.meta?.page ?? 1);
        setModelOptions(Array.from(new Set(data.filters?.models ?? [])));
        setRouteOptions(Array.from(new Set(data.filters?.routes ?? [])));
      } catch (err) {
        setOverviewError("无法加载实时用量：" + (err as Error).message);
        setOverview(null);
      } finally {
        setLoadingOverview(false);
      }
    };
    loadOverview();
  }, [rangeDays, filterModel, filterRoute, page, refreshTrigger, ready]);

  const overviewData = overview;
  const showEmpty = overviewEmpty || !overview;
  
  const hourlySeries = useMemo(() => {
    if (!overviewData?.byHour) return [] as UsageSeriesPoint[];
    if (hourRange === "all") return overviewData.byHour;
    const hours = hourRange === "12h" ? 12 : 24;
    return buildHourlySeries(overviewData.byHour, hours);
  }, [hourRange, overviewData?.byHour]);

  const hourRangeOptions: { key: "all" | "12h" | "24h"; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "12h", label: "最近 12 小时" },
    { key: "24h", label: "最近 24 小时" }
  ];

  const priceModelOptions = useMemo(() => {
    const names = new Set<string>();
    modelOptions.forEach((m) => names.add(m));
    prices.forEach((p) => names.add(p.model));
    overviewData?.models?.forEach((m) => names.add(m.model));
    return Array.from(names);
  }, [modelOptions, prices, overviewData?.models]);

  const sortedModelsByCost = useMemo(() => {
    const models = overviewData?.models ?? [];
    return [...models].sort((a, b) => b.cost - a.cost);
  }, [overviewData]);


  const applyFilters = () => {
    setPage(1);
    setFilterModel(filterModelInput.trim() || undefined);
    setFilterRoute(filterRouteInput.trim() || undefined);
  };

  const applyModelOption = (val: string) => {
    setFilterModelInput(val);
    setFilterModel(val.trim() || undefined);
    setPage(1);
  };

  const applyRouteOption = (val: string) => {
    setFilterRouteInput(val);
    setFilterRoute(val.trim() || undefined);
    setPage(1);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(null);
    setSaving(true);

    const payload = {
      model: form.model.trim(),
      inputPricePer1M: Number(form.inputPricePer1M),
      cachedInputPricePer1M: Number(form.cachedInputPricePer1M) || 0,
      outputPricePer1M: Number(form.outputPricePer1M)
    };

    if (!payload.model || Number.isNaN(payload.inputPricePer1M) || Number.isNaN(payload.outputPricePer1M)) {
      setStatus("请输入有效的模型名称和单价");
      setSaving(false);
      return;
    }

    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        setStatus("保存失败，请检查后端日志/环境变量");
      } else {
        setPrices((prev: ModelPrice[]) => {
          const others = prev.filter((p) => p.model !== payload.model);
          return [...others, payload].sort((a, b) => a.model.localeCompare(b.model));
        });
        setForm({ model: "", inputPricePer1M: "", cachedInputPricePer1M: "", outputPricePer1M: "" });
        setStatus("已保存");
        // 刷新 overview 数据以更新费用计算
        setRefreshTrigger((prev) => prev + 1);
      }
    } catch (err) {
      setStatus("请求失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  // 删除价格
  const handleDeletePrice = async (model: string) => {
    try {
      const res = await fetch("/api/prices", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model })
      });
      if (res.ok) {
        setPrices((prev) => prev.filter((p) => p.model !== model));
        setRefreshTrigger((prev) => prev + 1);
      }
    } catch (err) {
      console.error("删除失败", err);
    }
  };

  const confirmDeletePrice = async () => {
    if (!pendingDelete) return;
    await handleDeletePrice(pendingDelete);
    setPendingDelete(null);
  };

  // 打开编辑弹窗
  const openEditModal = (price: ModelPrice) => {
    setEditingPrice(price);
    setEditForm({
      model: price.model,
      inputPricePer1M: String(price.inputPricePer1M),
      cachedInputPricePer1M: String(price.cachedInputPricePer1M || 0),
      outputPricePer1M: String(price.outputPricePer1M)
    });
  };

  // 保存编辑
  const handleEditSave = async () => {
    if (!editingPrice) return;
    const payload = {
      model: editForm.model.trim(),
      inputPricePer1M: Number(editForm.inputPricePer1M),
      cachedInputPricePer1M: Number(editForm.cachedInputPricePer1M) || 0,
      outputPricePer1M: Number(editForm.outputPricePer1M)
    };
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setPrices((prev) => {
          const others = prev.filter((p) => p.model !== editingPrice.model && p.model !== payload.model);
          return [...others, payload].sort((a, b) => a.model.localeCompare(b.model));
        });
        setEditingPrice(null);
        setRefreshTrigger((prev) => prev + 1);
      }
    } catch (err) {
      console.error("保存失败", err);
    }
  };

  return (
    <main className={`min-h-screen px-6 py-8 transition-colors ${darkMode ? "bg-slate-900 text-slate-100" : "bg-slate-50 text-slate-900"}`}>
      {overviewError ? (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <p className="font-semibold">加载失败</p>
            <p className="text-red-300">{overviewError}</p>
          </div>
        </div>
      ) : null}

      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className={`text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>Usage Dashboard</h1>
          <p className={`text-base ${darkMode ? "text-slate-400" : "text-slate-600"}`}>持久化的 CLIProxy 使用统计与费用分析</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setDarkMode((d) => !d)}
            className={`rounded-lg border p-2 transition ${
              darkMode
                ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"
                : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
            }`}
            title={darkMode ? "切换到亮色模式" : "切换到暗色模式"}
          >
            {darkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            onClick={() => doSync(true)}
            disabled={syncing}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
              syncing
                ? "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-500"
                : "border-indigo-500/50 bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30"
            }`}
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "同步中..." : "刷新数据"}
          </button>
          <div className="flex flex-col items-end gap-0.5">
            <div className={`flex items-center gap-2 text-sm ${darkMode ? "text-slate-400" : "text-slate-600"}`}>
              <Activity className="h-4 w-4" />
              {loadingOverview ? "加载中..." : overview ? "实时数据" : "暂无数据"}
            </div>
            {lastSyncTime && (
              <span className={`text-xs ${darkMode ? "text-slate-500" : "text-slate-500"}`}>
                上次同步: {lastSyncTime.toLocaleTimeString()}
              </span>
            )}
            {syncStatus && (
              <span className={`text-xs ${syncStatus.includes("失败") ? "text-red-400" : "text-green-400"}`}>
                {syncStatus}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="text-sm uppercase tracking-wide text-slate-500">时间范围</span>
        {[7, 14, 30].map((days) => (
          <button
            key={days}
            onClick={() => {
              setRangeDays(days);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              rangeDays === days
                ? "border-indigo-500 bg-indigo-600 text-white"
                : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
            }`}
          >
            最近 {days} 天
          </button>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <ComboBox
            value={filterModelInput}
            onChange={setFilterModelInput}
            options={modelOptions}
            placeholder="按模型过滤"
            darkMode={darkMode}
            onSelectOption={applyModelOption}
          />
          <ComboBox
            value={filterRouteInput}
            onChange={setFilterRouteInput}
            options={routeOptions}
            placeholder="按 Key 过滤"
            darkMode={darkMode}
            onSelectOption={applyRouteOption}
          />
          <button
            onClick={applyFilters}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"}`}
          >
            应用筛选
          </button>
          {(filterModel || filterRoute) ? (
            <button
              onClick={() => {
                setFilterModelInput("");
                setFilterRouteInput("");
                setFilterModel(undefined);
                setFilterRoute(undefined);
                setPage(1);
              }}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${darkMode ? "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"}`}
            >
              清除
            </button>
          ) : null}
        </div>
        {loadingOverview ? <span className="text-sm text-slate-400">加载中...</span> : null}
        {showEmpty ? <span className="text-sm text-slate-400">暂无数据，先触发同步</span> : null}
      </div>

      {/* 统计卡片 - 单行填满 */}
      <section className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
        {loadingOverview || !overviewData ? (
          <>
            {/* 请求数 skeleton */}
            <Skeleton className="h-28 rounded-2xl" />
            {/* Tokens skeleton - 2列 */}
            <div className="col-span-2">
              <Skeleton className="h-28 rounded-2xl" />
            </div>
            {/* 成功率 skeleton */}
            <Skeleton className="h-28 rounded-2xl" />
            {/* TPM skeleton */}
            <Skeleton className="h-28 rounded-2xl" />
            {/* RPM skeleton */}
            <Skeleton className="h-28 rounded-2xl" />
            {/* 费用 skeleton */}
            <Skeleton className="h-28 rounded-2xl" />
          </>
        ) : (
          <>
            {/* 请求数 */}
            <div className={`rounded-2xl p-5 shadow-sm ring-1 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`}>
              <div className={`text-sm uppercase tracking-wide ${darkMode ? "text-slate-400" : "text-slate-500"}`}>请求数</div>
              <div className={`mt-3 text-2xl font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>{formatNumberWithCommas(overviewData.totalRequests)}</div>
              <p className="mt-2 text-sm">
                <span className="text-emerald-400">✓ {formatCompactNumber(overviewData.successCount)}</span>
                <span className={`mx-2 ${darkMode ? "text-slate-500" : "text-slate-400"}`}>|</span>
                <span className="text-red-400">✗ {formatCompactNumber(overviewData.failureCount)}</span>
              </p>
            </div>
            
            {/* Tokens - 占两列 */}
            <div className={`col-span-2 rounded-2xl p-5 shadow-sm ring-1 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`}>
              <div className="flex items-center justify-between">
                <div className={`text-sm uppercase tracking-wide ${darkMode ? "text-slate-400" : "text-slate-500"}`}>Tokens</div>
                <div className={`text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>
                  {formatNumberWithCommas(overviewData.totalTokens)}
                  <span className={`ml-2 text-lg font-normal ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                    ({formatCompactNumber(overviewData.totalTokens)})
                  </span>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className={darkMode ? "text-slate-400" : "text-slate-500"}>输入</span>
                  <span className="font-medium text-blue-400">{formatNumberWithCommas(overviewData.totalInputTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={darkMode ? "text-slate-400" : "text-slate-500"}>输出</span>
                  <span className="font-medium text-emerald-400">{formatNumberWithCommas(overviewData.totalOutputTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={darkMode ? "text-slate-400" : "text-slate-500"}>思考</span>
                  <span className="font-medium text-amber-400">{formatNumberWithCommas(overviewData.totalReasoningTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={darkMode ? "text-slate-400" : "text-slate-500"}>缓存</span>
                  <span className="font-medium text-purple-400">{formatNumberWithCommas(overviewData.totalCachedTokens)}</span>
                </div>
              </div>
            </div>
            
            {/* 预估费用 */}
            <div className={`rounded-2xl p-5 shadow-sm ring-1 ${darkMode ? "bg-gradient-to-br from-amber-500/20 to-amber-700/10 ring-amber-400/40" : "bg-amber-50 ring-amber-200"}`}>
              <div className="text-sm uppercase tracking-wide text-amber-400">预估费用</div>
              <div className={`mt-3 text-2xl font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>{formatCurrency(overviewData.totalCost)}</div>
              <p className={`mt-2 text-xs ${darkMode ? "text-amber-300/70" : "text-amber-700/70"}`}>基于模型价格</p>
            </div>

            {/* TPM */}
            <div className={`rounded-2xl p-5 shadow-sm ring-1 ${darkMode ? "bg-gradient-to-br from-emerald-600/20 to-emerald-800/10 ring-emerald-500/30" : "bg-emerald-50 ring-emerald-200"}`}>
              <div className="text-sm uppercase tracking-wide text-emerald-400">平均 TPM</div>
              <div className={`mt-3 text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>
                {(overviewData.totalTokens / (rangeDays * 24 * 60)).toFixed(2)}
              </div>
              <p className={`mt-2 text-xs ${darkMode ? "text-emerald-300/70" : "text-emerald-600/70"}`}>每分钟Token</p>
            </div>

            {/* RPM */}
            <div className={`rounded-2xl p-5 shadow-sm ring-1 ${darkMode ? "bg-gradient-to-br from-blue-600/20 to-blue-800/10 ring-blue-500/30" : "bg-blue-50 ring-blue-200"}`}>
              <div className="text-sm uppercase tracking-wide text-blue-400">平均 RPM</div>
              <div className={`mt-3 text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>
                {(overviewData.totalRequests / (rangeDays * 24 * 60)).toFixed(2)}
              </div>
              <p className={`mt-2 text-xs ${darkMode ? "text-blue-300/70" : "text-blue-600/70"}`}>每分钟请求</p>
            </div>

            {/* 日均请求 */}
            <div className={`rounded-2xl p-5 shadow-sm ring-1 ${darkMode ? "bg-gradient-to-br from-purple-600/20 to-purple-800/10 ring-purple-500/30" : "bg-purple-50 ring-purple-200"}`}>
              <div className="text-sm uppercase tracking-wide text-purple-400">日均请求 (RPD)</div>
              <div className={`mt-3 text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>
                {formatCompactNumber(Math.round(overviewData.totalRequests / rangeDays))}
              </div>
              <p className={`mt-2 text-xs ${darkMode ? "text-purple-300/70" : "text-purple-600/70"}`}>每日请求数</p>
            </div>
          </>
        )}
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-5">
        <div className={`rounded-2xl p-6 shadow-sm ring-1 lg:col-span-3 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`}>
          <div className="flex items-center justify-between">
            <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>每日用量趋势</h2>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>{`最近 ${rangeDays} 天`}</span>
              <button
                type="button"
                onClick={() => setFullscreenChart("trend")}
                className={`rounded-lg p-1.5 transition ${darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-white" : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"}`}
                title="全屏查看"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-4 h-64">
            {loadingOverview ? (
              <Skeleton className="h-full rounded-xl" />
            ) : showEmpty || !overviewData ? (
              <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 text-center">
                <p className="text-base text-slate-400">暂无图表数据</p>
                <p className="mt-1 text-sm text-slate-500">请先触发 /api/sync 同步数据</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={overviewData.byDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#334155" strokeDasharray="5 5" />
                  <XAxis dataKey="label" stroke="#94a3b8" fontSize={12} />
                  <YAxis yAxisId="left" stroke="#3b82f6" tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke="#10b981"
                    tickFormatter={(v) => formatCompactNumber(v)}
                    fontSize={12}
                  />
                  <YAxis
                    yAxisId="cost"
                    orientation="right"
                    stroke="#fbbf24"
                    tickFormatter={(v) => formatCurrency(v)}
                    fontSize={12}
                    hide
                  />
                  <Tooltip 
                    contentStyle={{ borderRadius: 12, backgroundColor: "#1e293b", border: "1px solid #334155", color: "#f1f5f9" }}
                    formatter={(value: number, name: string) => name === "费用" ? [formatCurrency(value), name] : [formatNumberWithCommas(value), name]}
                  />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="requests" stroke="#3b82f6" strokeWidth={2} name="请求数" dot={{ r: 3 }} />
                  <Line yAxisId="right" type="monotone" dataKey="tokens" stroke="#10b981" strokeWidth={2} name="Tokens" dot={{ r: 3 }} />
                  <Line yAxisId="cost" type="monotone" dataKey="cost" stroke="#fbbf24" strokeWidth={2} name="费用" dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 模型用量饼图 */}
        <div className={`rounded-2xl p-6 shadow-sm ring-1 lg:col-span-2 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`}>
          <div className="flex items-center justify-between">
            <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>模型用量分布</h2>
            <div className="flex items-center gap-2">
              <div className={`flex items-center gap-1 rounded-lg border p-0.5 ${darkMode ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-slate-100"}`}>
                <button
                  onClick={() => setPieMode("tokens")}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition ${pieMode === "tokens" ? "bg-indigo-600 text-white" : darkMode ? "text-slate-400 hover:text-slate-200" : "text-slate-600 hover:text-slate-900"}`}
                >
                  Token
                </button>
                <button
                  onClick={() => setPieMode("requests")}
                  className={`rounded-md px-2 py-1 text-xs font-medium transition ${pieMode === "requests" ? "bg-indigo-600 text-white" : darkMode ? "text-slate-400 hover:text-slate-200" : "text-slate-600 hover:text-slate-900"}`}
                >
                  请求
                </button>
              </div>
              <button
                type="button"
                onClick={() => setFullscreenChart("pie")}
                className={`rounded-lg p-1.5 transition ${darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-white" : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"}`}
                title="全屏查看"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-2 h-72">
            {loadingOverview ? (
              <Skeleton className="h-full rounded-xl" />
            ) : showEmpty || !overviewData || overviewData.models.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 text-center">
                <p className="text-base text-slate-400">暂无模型数据</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                  <Pie
                    data={overviewData.models}
                    dataKey={pieMode}
                    nameKey="model"
                    cx="50%"
                    cy="50%"
                    outerRadius="70%"
                    innerRadius="30%"
                    label={({ model, percent }) => `${model.length > 16 ? model.slice(0, 16) + ".." : model} ${(percent * 100).toFixed(0)}%`}
                    labelLine={{ stroke: darkMode ? "#94a3b8" : "#64748b", strokeWidth: 1 }}
                    fontSize={11}
                    animationDuration={300}
                  >
                    {overviewData.models.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ borderRadius: 12, backgroundColor: darkMode ? "#1e293b" : "#fff", border: darkMode ? "1px solid #334155" : "1px solid #e2e8f0", color: darkMode ? "#f1f5f9" : "#1e293b" }}
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload[0]) return null;
                      const data = payload[0].payload;
                      return (
                        <div className={`rounded-xl border px-3 py-2 text-sm shadow-lg ${darkMode ? "border-slate-700 bg-slate-800" : "border-slate-200 bg-white"}`}>
                          <p className={`font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>{data.model}</p>
                          <p className={darkMode ? "text-slate-300" : "text-slate-600"}>{formatNumberWithCommas(data.tokens)} tokens</p>
                          <p className={darkMode ? "text-slate-300" : "text-slate-600"}>{formatNumberWithCommas(data.requests)} 请求</p>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* 第二行：每小时负载 + 模型费用 */}
      <section className="mt-6 grid gap-6 lg:grid-cols-5">
        {/* 每小时负载分布 */}
        <div className={`rounded-2xl p-6 shadow-sm ring-1 lg:col-span-3 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>每小时负载分布</h2>
              <div className="flex items-center gap-1">
                {hourRangeOptions.map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => setHourRange(opt.key)}
                    className={`rounded-md border px-2 py-1 text-xs transition ${
                      hourRange === opt.key
                        ? "border-indigo-500 bg-indigo-600 text-white"
                        : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`flex items-center gap-1 text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                <Info className="h-3 w-3" />
                Token 类型分布
              </span>
              <button
                type="button"
                onClick={() => setFullscreenChart("stacked")}
                className={`rounded-lg p-1.5 transition ${darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-white" : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"}`}
                title="全屏查看"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-4 h-64">
            {loadingOverview ? (
              <Skeleton className="h-full rounded-xl" />
            ) : !overviewData || showEmpty ? (
              <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 text-center">
                <p className="text-base text-slate-400">暂无小时数据</p>
                <p className="mt-1 text-sm text-slate-500">请先触发 /api/sync 同步数据</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={hourlySeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? "#334155" : "#e2e8f0"} />
                  <XAxis dataKey="label" stroke={darkMode ? "#94a3b8" : "#64748b"} fontSize={12} tickFormatter={formatHourLabel} />
                  <YAxis yAxisId="left" stroke="#3b82f6" tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                  <YAxis yAxisId="right" orientation="right" stroke={darkMode ? "#94a3b8" : "#64748b"} tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                  <Tooltip 
                    contentStyle={{ borderRadius: 12, backgroundColor: darkMode ? "#1e293b" : "#fff", border: darkMode ? "1px solid #334155" : "1px solid #e2e8f0", color: darkMode ? "#f1f5f9" : "#1e293b" }} 
                    formatter={(value: number, name: string) => [formatNumberWithCommas(value), name]}
                    labelFormatter={(label) => formatHourLabel(label)}
                  />
                  <Legend />
                  {/* 堆积柱状图 - 柔和配色，仅顶部圆角 */}
                  <Bar yAxisId="right" dataKey="inputTokens" name="输入" stackId="tokens" fill="#60a5fa" />
                  <Bar yAxisId="right" dataKey="outputTokens" name="输出" stackId="tokens" fill="#4ade80" />
                  <Bar yAxisId="right" dataKey="reasoningTokens" name="思考" stackId="tokens" fill="#fbbf24" />
                  <Bar yAxisId="right" dataKey="cachedTokens" name="缓存" stackId="tokens" fill="#c084fc" radius={[4, 4, 0, 0]} />
                  {/* 曲线在最上层 - 带描边突出显示 */}
                  <Line 
                    yAxisId="left" 
                    type="monotone" 
                    dataKey="requests" 
                    name="请求数" 
                    stroke="#3b82f6" 
                    strokeWidth={3} 
                    dot={{ r: 4, fill: "#3b82f6", stroke: "#fff", strokeWidth: 2 }} 
                    activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} 
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 模型费用 */}
        <div className={`rounded-2xl p-6 shadow-sm ring-1 lg:col-span-2 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`}>
          <div className="flex items-center justify-between">
            <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>预估模型费用</h2>
            <span className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>基于配置的价格</span>
          </div>
          <div className="scrollbar-slim mt-4 max-h-56 space-y-2 overflow-y-auto">
            {loadingOverview ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={`model-skel-${i}`} className="rounded-xl">
                  <Skeleton className="h-14 rounded-xl" />
                </div>
              ))
            ) : showEmpty || !overviewData ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 py-6 text-center">
                <p className="text-base text-slate-400">暂无模型数据</p>
              </div>
            ) : sortedModelsByCost.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 py-6 text-center">
                <p className="text-base text-slate-400">无匹配的模型</p>
              </div>
            ) : (
              sortedModelsByCost.map((model) => (
                <div
                  key={model.model}
                  className={`flex items-center justify-between rounded-xl border px-4 py-2.5 ${darkMode ? "border-slate-700 bg-slate-800/80" : "border-slate-200 bg-white"}`}
                >
                  <div>
                    <p className={`text-sm font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>{model.model}</p>
                    <p className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-600"}`}>
                      {formatNumberWithCommas(model.requests)} 请求 • {formatCompactNumber(model.tokens)} tokens
                    </p>
                  </div>
                  <div className={`text-base font-semibold ${darkMode ? "text-emerald-400" : "text-emerald-600"}`}>{formatCurrency(model.cost)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className={`mt-8 rounded-2xl p-6 shadow-sm ring-1 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`}>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>模型价格配置</h2>
            <p className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>设置每百万 tokens 单价，费用计算将立即更新</p>
          </div>
          {status ? <p className="text-xs text-emerald-400">{status}</p> : null}
        </div>

        <div className="mt-4 grid gap-6 lg:grid-cols-5">
          <form onSubmit={handleSubmit} className={`rounded-xl border p-4 lg:col-span-2 ${darkMode ? "border-slate-700 bg-slate-800/50" : "border-slate-200 bg-slate-50"}`}>
            <div className="grid gap-3">
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                模型名称
                <ComboBox
                  value={form.model}
                  onChange={(val) => setForm((f) => ({ ...f, model: val }))}
                  options={priceModelOptions}
                  placeholder="gpt-4o（支持通配符如 gemini-2*）"
                  darkMode={darkMode}
                  className="mt-1 w-full"
                />
              </label>
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                输入（$ / M tokens）
                <input
                  type="number"
                  step="0.01"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  placeholder="2.5"
                  value={form.inputPricePer1M}
                  onChange={(e) => setForm((f) => ({ ...f, inputPricePer1M: e.target.value }))}
                />
              </label>
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                缓存输入（$ / M tokens）
                <input
                  type="number"
                  step="0.01"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  placeholder="0.5（可选，默认为 0）"
                  value={form.cachedInputPricePer1M}
                  onChange={(e) => setForm((f) => ({ ...f, cachedInputPricePer1M: e.target.value }))}
                />
              </label>
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                输出（$ / M tokens）
                <input
                  type="number"
                  step="0.01"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  placeholder="10"
                  value={form.outputPricePer1M}
                  onChange={(e) => setForm((f) => ({ ...f, outputPricePer1M: e.target.value }))}
                />
              </label>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
              >
                <Save className="mr-2 h-4 w-4" />
                {saving ? "保存中..." : "保存价格"}
              </button>
            </div>
          </form>

          <div className="lg:col-span-3">
            <div className="scrollbar-slim grid max-h-[520px] gap-3 overflow-y-auto pr-1">
              {prices.length ? prices.map((price) => (
                <div key={price.model} className={`flex items-center justify-between rounded-xl border px-4 py-3 ${darkMode ? "border-slate-700 bg-slate-800/50" : "border-slate-200 bg-slate-50"}`}>
                  <div>
                    <p className={`text-base font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>{price.model}</p>
                    <p className={`text-sm ${darkMode ? "text-slate-400" : "text-slate-600"}`}>
                      ${price.inputPricePer1M}/M 输入
                      {price.cachedInputPricePer1M > 0 && ` • $${price.cachedInputPricePer1M}/M 缓存`}
                      {" • "}${price.outputPricePer1M}/M 输出
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEditModal(price)}
                      className={`rounded-lg p-2 transition ${darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-white" : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"}`}
                      title="编辑"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(price.model)}
                      className={`rounded-lg p-2 transition ${darkMode ? "text-red-400 hover:bg-red-900/50 hover:text-red-300" : "text-red-500 hover:bg-red-100 hover:text-red-700"}`}
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )) : (
                <div className={`flex flex-col items-center justify-center rounded-xl border border-dashed py-8 text-center ${darkMode ? "border-slate-700 bg-slate-800/30" : "border-slate-300 bg-slate-50"}`}>
                  <p className="text-base text-slate-400">暂无已配置价格</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 编辑价格模态框 */}
      {editingPrice && (
        <div 
          className="animate-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setEditingPrice(null); }}
        >
          <div className={`animate-modal-content relative w-full max-w-md rounded-2xl p-6 shadow-xl ${darkMode ? "bg-slate-800" : "bg-white"}`}>
            <button
              type="button"
              onClick={() => setEditingPrice(null)}
              className={`absolute right-4 top-4 rounded-lg p-1 transition ${darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-white" : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"}`}
            >
              <X className="h-5 w-5" />
            </button>
            <h3 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>编辑价格</h3>
            <div className="mt-4 grid gap-3">
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                模型名称
                <input
                  type="text"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  placeholder="模型名称"
                  value={editForm.model}
                  onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))}
                />
              </label>
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                输入（$ / M tokens）
                <input
                  type="number"
                  step="0.01"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  value={editForm.inputPricePer1M}
                  onChange={(e) => setEditForm((f) => ({ ...f, inputPricePer1M: e.target.value }))}
                />
              </label>
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                缓存输入（$ / M tokens）
                <input
                  type="number"
                  step="0.01"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  value={editForm.cachedInputPricePer1M}
                  onChange={(e) => setEditForm((f) => ({ ...f, cachedInputPricePer1M: e.target.value }))}
                />
              </label>
              <label className={`text-sm font-medium ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                输出（$ / M tokens）
                <input
                  type="number"
                  step="0.01"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  value={editForm.outputPricePer1M}
                  onChange={(e) => setEditForm((f) => ({ ...f, outputPricePer1M: e.target.value }))}
                />
              </label>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditingPrice(null)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${darkMode ? "border-slate-600 text-slate-300 hover:bg-slate-700" : "border-slate-300 text-slate-700 hover:bg-slate-100"}`}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleEditSave}
                  className="flex-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除价格确认模态框 */}
      {pendingDelete && (
        <div
          className="animate-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingDelete(null);
          }}
        >
          <div className={`animate-modal-content relative w-full max-w-md rounded-2xl p-6 shadow-xl ${darkMode ? "bg-slate-800" : "bg-white"}`}>
            <h3 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>确认删除</h3>
            <p className={`mt-2 text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
              删除模型 {pendingDelete} 的价格配置？此操作不可恢复。
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${darkMode ? "border-slate-600 text-slate-300 hover:bg-slate-700" : "border-slate-300 text-slate-700 hover:bg-slate-100"}`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmDeletePrice}
                className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全屏图表模态框 */}
      {fullscreenChart && (
        <div 
          className="animate-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
          onClick={(e) => { if (e.target === e.currentTarget) setFullscreenChart(null); }}
        >
          <div className={`animate-modal-content relative w-full max-w-6xl rounded-2xl p-6 shadow-xl ${darkMode ? "bg-slate-800" : "bg-white"}`}>
            <button
              type="button"
              onClick={() => setFullscreenChart(null)}
              className={`absolute right-4 top-4 rounded-lg p-1 transition ${darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-white" : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"}`}
            >
              <X className="h-5 w-5" />
            </button>
            <h3 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>
              {fullscreenChart === "trend" && "每日请求与 Token 趋势"}
              {fullscreenChart === "pie" && "模型用量分布"}
              {fullscreenChart === "stacked" && "每小时负载分布"}
            </h3>
            <div className="mt-4 h-[70vh]">
              {fullscreenChart === "trend" && overviewData && (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overviewData.byDay} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#334155" strokeDasharray="5 5" />
                    <XAxis dataKey="label" stroke="#94a3b8" fontSize={12} />
                    <YAxis yAxisId="left" stroke="#3b82f6" tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                    <YAxis yAxisId="right" orientation="right" stroke="#10b981" tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                    <YAxis yAxisId="cost" orientation="right" stroke="#fbbf24" tickFormatter={(v) => formatCurrency(v)} fontSize={12} />
                    <Tooltip
                      contentStyle={{ borderRadius: 12, backgroundColor: "#1e293b", border: "1px solid #334155", color: "#f1f5f9" }}
                      formatter={(value: number, name: string) => name === "费用" ? [formatCurrency(value), name] : [formatNumberWithCommas(value), name]}
                    />
                    <Legend />
                    <Line yAxisId="left" type="monotone" dataKey="requests" stroke="#3b82f6" strokeWidth={2} name="请求数" dot={{ r: 3 }} />
                    <Line yAxisId="right" type="monotone" dataKey="tokens" stroke="#10b981" strokeWidth={2} name="Tokens" dot={{ r: 3 }} />
                    <Line yAxisId="cost" type="monotone" dataKey="cost" stroke="#fbbf24" strokeWidth={2} name="费用" dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
              {fullscreenChart === "pie" && overviewData && overviewData.models.length > 0 && (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <Pie
                      data={overviewData.models}
                      dataKey={pieMode}
                      nameKey="model"
                      cx="50%"
                      cy="50%"
                      outerRadius="60%"
                      innerRadius="25%"
                      label={({ model, percent }) => `${model.length > 20 ? model.slice(0, 20) + ".." : model} ${(percent * 100).toFixed(1)}%`}
                      labelLine={{ stroke: darkMode ? "#94a3b8" : "#64748b", strokeWidth: 1 }}
                      fontSize={12}
                      animationDuration={300}
                    >
                      {overviewData.models.map((_, index) => (
                        <Cell key={`cell-fs-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ borderRadius: 12, backgroundColor: "#1e293b", border: "1px solid #334155", color: "#f1f5f9" }} formatter={(value: number) => [formatNumberWithCommas(value), pieMode === "tokens" ? "Tokens" : "请求"]} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
              {fullscreenChart === "stacked" && overviewData && (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={hourlySeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? "#334155" : "#e2e8f0"} />
                    <XAxis dataKey="label" stroke={darkMode ? "#94a3b8" : "#64748b"} fontSize={12} tickFormatter={formatHourLabel} />
                    <YAxis yAxisId="left" stroke="#3b82f6" tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                    <YAxis yAxisId="right" orientation="right" stroke={darkMode ? "#94a3b8" : "#64748b"} tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                    <Tooltip 
                      contentStyle={{ borderRadius: 12, backgroundColor: darkMode ? "#1e293b" : "#fff", border: darkMode ? "1px solid #334155" : "1px solid #e2e8f0", color: darkMode ? "#f1f5f9" : "#1e293b" }} 
                      formatter={(value: number, name: string) => [formatNumberWithCommas(value), name]}
                      labelFormatter={(label) => formatHourLabel(label)}
                    />
                    <Legend />
                    <Bar yAxisId="right" dataKey="inputTokens" name="输入" stackId="tokens" fill="#60a5fa" />
                    <Bar yAxisId="right" dataKey="outputTokens" name="输出" stackId="tokens" fill="#4ade80" />
                    <Bar yAxisId="right" dataKey="reasoningTokens" name="思考" stackId="tokens" fill="#fbbf24" />
                    <Bar yAxisId="right" dataKey="cachedTokens" name="缓存" stackId="tokens" fill="#c084fc" radius={[4, 4, 0, 0]} />
                    <Line 
                      yAxisId="left" 
                      type="monotone" 
                      dataKey="requests" 
                      name="请求数" 
                      stroke="#3b82f6" 
                      strokeWidth={3} 
                      dot={{ r: 4, fill: "#3b82f6", stroke: "#fff", strokeWidth: 2 }} 
                      activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} 
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function StatCard({ label, value, hint, subValue, icon: Icon }: { label: string; value: string; hint?: string; subValue?: string; icon?: LucideIcon }) {
  return (
    <div className="rounded-2xl bg-slate-800/50 p-5 shadow-sm ring-1 ring-slate-700">
      <div className="flex items-center gap-2 text-sm uppercase tracking-wide text-slate-400">
        {Icon ? <Icon className="h-4 w-4" /> : null}
        {label}
      </div>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
      {subValue ? <p className="mt-2 text-sm text-slate-300">{subValue}</p> : null}
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  darkMode,
  className,
  onSelectOption
}: {
  value: string;
  onChange: (val: string) => void;
  options: string[];
  placeholder?: string;
  darkMode: boolean;
  className?: string;
  onSelectOption?: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hasTyped, setHasTyped] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const filtered = useMemo(() => {
    if (!hasTyped) return options;
    return options.filter((opt) => opt.toLowerCase().includes(value.toLowerCase()));
  }, [hasTyped, options, value]);

  const baseInput = `${className ?? ""} rounded-lg border px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none ${
    darkMode ? "border-slate-700 bg-slate-800 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"
  }`;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setHasTyped(true);
          onChange(e.target.value);
        }}
        onFocus={() => {
          setOpen(true);
          setHasTyped(false);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        placeholder={placeholder}
        className={baseInput}
      />
      {open && filtered.length > 0 ? (
        <div
          className={`absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-xl border shadow-lg scrollbar-slim ${
            darkMode ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"
          }`}
        >
          {filtered.map((opt) => (
            <button
              type="button"
              key={opt}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(opt);
                setHasTyped(false);
                setOpen(false);
                inputRef.current?.blur();
                onSelectOption?.(opt);
              }}
              className={`block w-full px-3 py-2 text-left text-sm transition ${
                darkMode ? "text-slate-200 hover:bg-slate-800" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-slate-700/50 ${className ?? ""}`} />;
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/50 text-base text-slate-400">
      {message}
    </div>
  );
}
