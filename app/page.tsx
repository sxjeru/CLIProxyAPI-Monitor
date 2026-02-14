"use client";

import { useEffect, useState, useCallback, useMemo, useRef, startTransition, type FormEvent } from "react";
import { ResponsiveContainer, LineChart, Line, Area, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar, Legend, ComposedChart, PieChart, Pie, Cell } from "recharts";
import type { TooltipProps } from "recharts";
import { formatCurrency, formatNumber, formatCompactNumber, formatNumberWithCommas, formatHourLabel } from "@/lib/utils";
import { AlertTriangle, Info, LucideIcon, Activity, Save, RefreshCw, Moon, Sun, Pencil, Trash2, Maximize2, CalendarRange, X, DollarSign, Search } from "lucide-react";
import type { ModelPrice, UsageOverview, UsageSeriesPoint } from "@/lib/types";
import { Modal } from "@/app/components/Modal";

// 同步状态类型定义
type SyncStatus = 
  | { type: 'idle' }
  | { type: 'syncing'; message?: string }
  | { type: 'success'; message: string; summary?: { total: number; updated: number; skipped: number; failed: number } }
  | { type: 'error'; message: string };

// 饼图颜色
const PIE_COLORS = [
  "#60a5fa", "#4ade80", "#fbbf24", "#c084fc", "#f472b6", "#38bdf8", "#a3e635", "#fb923c",
  "#f87171", "#34d399", "#a78bfa", "#2dd4bf", "#818cf8",
  "#fb7185", "#86efac", "#fcd34d", "#d946ef", "#67e8f9", "#bef264", "#fdba74", "#c4b5fd"
];

type OverviewMeta = { page: number; pageSize: number; totalModels: number; totalPages: number };
type OverviewAPIResponse = { overview: UsageOverview | null; empty: boolean; days: number; timezone?: string; meta?: OverviewMeta; filters?: { models: string[]; routes: string[] } };

type PriceForm = {
  model: string;
  inputPricePer1M: string;
  cachedInputPricePer1M: string;
  outputPricePer1M: string;
};

const hourFormatter = new Intl.DateTimeFormat("en-CA", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hour12: false
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatDateInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

type TooltipValue = number | string | Array<number | string> | undefined;

function normalizeTooltipValue(value: TooltipValue) {
  if (Array.isArray(value)) return normalizeTooltipValue(value[0]);
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

const trendTooltipFormatter: TooltipProps<number, string>["formatter"] = (value, name) => {
  const numericValue = normalizeTooltipValue(value);
  return name === "费用" ? [formatCurrency(numericValue), name] : [formatNumberWithCommas(numericValue), name];
};

const numericTooltipFormatter: TooltipProps<number, string>["formatter"] = (value, name) => {
  const numericValue = normalizeTooltipValue(value);
  return [formatNumberWithCommas(numericValue), name];
};

function formatHourKeyFromTs(ts: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(new Date(ts));
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  const day = parts.find((p) => p.type === "day")?.value ?? "00";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  return `${month}-${day} ${hour}`;
}

function buildHourlySeries(series: UsageSeriesPoint[], rangeHours?: number, timezone?: string) {
  // Use the server's bucketing timezone for gap-fill labels so they match the
  // labels returned for real data points. Falls back to the module-level formatter
  // (browser timezone) when no timezone is provided.
  const gapFormatter = timezone
    ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
    : hourFormatter;
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
        label: formatHourKeyFromTs(ts, gapFormatter),
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

function buildHourlyLineStyle(pointCount: number, baseStrokeWidth: number) {
  const safeCount = Math.max(0, pointCount);
  const density = Math.min(1, Math.max(0, (safeCount - 36) / 120));
  const minStrokeWidth = 1.2;
  const strokeWidth = Number((baseStrokeWidth - (baseStrokeWidth - minStrokeWidth) * density).toFixed(2));
  const showDot = safeCount <= 72;
  const dotRadius = safeCount <= 24 ? 3 : safeCount <= 48 ? 2.5 : 2;
  const activeDotRadius = safeCount <= 72 ? 6 : safeCount <= 120 ? 5 : 4;

  return {
    strokeWidth,
    showDot,
    dotRadius,
    activeDotRadius
  };
}

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const [prices, setPrices] = useState<ModelPrice[]>([]);

  // 默认值 - 服务端和客户端首次渲染使用相同值
  const defaultEnd = new Date();
  const defaultStart = new Date(defaultEnd.getTime() - 6 * DAY_MS);
  const fallbackRange = { mode: "preset" as const, days: 14, start: formatDateInputValue(defaultStart), end: formatDateInputValue(defaultEnd) };

  const [rangeMode, setRangeMode] = useState<"preset" | "custom">(fallbackRange.mode);
  const [rangeDays, setRangeDays] = useState(fallbackRange.days);
  const [customStart, setCustomStart] = useState(fallbackRange.start);
  const [customEnd, setCustomEnd] = useState(fallbackRange.end);
  const [appliedDays, setAppliedDays] = useState(fallbackRange.days);

  useEffect(() => {
    setMounted(true);
    // 客户端挂载后从 localStorage 恢复用户选择
    const saved = window.localStorage.getItem("rangeSelection");
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as { mode?: "preset" | "custom"; days?: number; start?: string; end?: string };
        if (parsed && (parsed.mode === "preset" || parsed.mode === "custom")) {
          setRangeMode(parsed.mode);
          if (Number.isFinite(parsed.days)) {
            setRangeDays(Math.max(1, Number(parsed.days)));
            setAppliedDays(Math.max(1, Number(parsed.days)));
          }
          if (parsed.start) setCustomStart(parsed.start);
          if (parsed.end) setCustomEnd(parsed.end);
        }
      } catch (err) {
        console.warn("Failed to parse saved rangeSelection", err);
      }
    }
  }, []);
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [bucketTimezone, setBucketTimezone] = useState<string | undefined>(undefined);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewEmpty, setOverviewEmpty] = useState(false);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  const [customDraftStart, setCustomDraftStart] = useState(fallbackRange.start);
  const [customDraftEnd, setCustomDraftEnd] = useState(fallbackRange.end);
  const [customError, setCustomError] = useState<string | null>(null);
  const customPickerRef = useRef<HTMLDivElement | null>(null);
  const [hourRange, setHourRange] = useState<"all" | "24h" | "72h">("all");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [routeOptions, setRouteOptions] = useState<string[]>([]);
  const [filterModelInput, setFilterModelInput] = useState("");
  const [filterRouteInput, setFilterRouteInput] = useState("");
  const [filterModel, setFilterModel] = useState<string | undefined>(undefined);
  const [filterRoute, setFilterRoute] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<PriceForm>({ model: "", inputPricePer1M: "", cachedInputPricePer1M: "", outputPricePer1M: "" });
  const [status, setStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const saveStatusTimerRef = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const syncStatusTimerRef = useRef<number | null>(null);
  const [syncStatusClosing, setSyncStatusClosing] = useState(false);
  const [saveStatusClosing, setSaveStatusClosing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(() => {
    if (typeof window === "undefined") return null;
    const saved = window.localStorage.getItem("lastSyncTime");
    return saved ? new Date(saved) : null;
  });
  const [lastInsertedDelta, setLastInsertedDelta] = useState(() => {
    if (typeof window === "undefined") return 0;
    const saved = window.localStorage.getItem("lastInsertedDelta");
    const parsed = saved ? Number.parseInt(saved, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  });
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [ready, setReady] = useState(false);
  const [pieMode, setPieMode] = useState<"tokens" | "requests">("tokens");
  const [darkMode, setDarkMode] = useState(true);
  const [editingPrice, setEditingPrice] = useState<ModelPrice | null>(null);
  const [editForm, setEditForm] = useState<PriceForm>({ model: "", inputPricePer1M: "", cachedInputPricePer1M: "", outputPricePer1M: "" });
  const [fullscreenChart, setFullscreenChart] = useState<"trend" | "pie" | "stacked" | null>(null);
  const [hoveredPieIndex, setHoveredPieIndex] = useState<number | null>(null);
  const [pieTooltipOpen, setPieTooltipOpen] = useState(false);
  const pieChartContainerRef = useRef<HTMLDivElement | null>(null);
  const pieChartFullscreenContainerRef = useRef<HTMLDivElement | null>(null);
  const pieLegendClearTimerRef = useRef<number | null>(null);
  const syncingRef = useRef(false);
  const skipOverviewCacheRef = useRef(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [syncingPrices, setSyncingPrices] = useState(false);
  // const [pricesSyncStatus, setPricesSyncStatus] = useState<SyncStatus>({ type: 'idle' }); // 已禁用 toast 通知
  // const pricesSyncStatusTimerRef = useRef<number | null>(null); // 已禁用 toast 通知
  const [pricesSyncModalOpen, setPricesSyncModalOpen] = useState(false);
  const [pricesSyncData, setPricesSyncData] = useState<{
    summary?: { total: number; updated: number; skipped: number; failed: number };
    details?: { model: string; status: string; reason?: string; matchedWith?: string }[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "rangeSelection",
      JSON.stringify({ mode: rangeMode, days: rangeDays, start: customStart, end: customEnd })
    );
  }, [rangeMode, rangeDays, customStart, customEnd]);

  const [trendVisible, setTrendVisible] = useState<Record<string, boolean>>({
    requests: true,
    tokens: true,
    cost: true,
  });

  const [hourlyVisible, setHourlyVisible] = useState<Record<string, boolean>>({
    requests: true,
    inputTokens: true,
    outputTokens: true,
    reasoningTokens: true,
    cachedTokens: true,
  });

  const [fullscreenHourlyMode, setFullscreenHourlyMode] = useState<"bar" | "area">("area");

  const handleTrendLegendClick = (e: any) => {
    const { dataKey } = e;
    setTrendVisible((prev) => ({
      ...prev,
      [dataKey]: !prev[dataKey as string],
    }));
  };

  const handleHourlyLegendClick = (e: any, _index?: any, event?: any) => {
    const key = e.dataKey ?? e.payload?.dataKey ?? e.id;
    if (!key) return;
    
    // 检查是否为 Ctrl/Cmd+左键
    const nativeEvent = event?.nativeEvent || event;
    const isModifierClick = nativeEvent && (nativeEvent.ctrlKey || nativeEvent.metaKey);
    
    if (isModifierClick) {
      // Ctrl/Cmd+左键：只显示当前项或恢复全部显示
      const allOthersHidden = Object.keys(hourlyVisible).every(k => k === key || !hourlyVisible[k]);
      
      if (allOthersHidden) {
        // 如果其他都已隐藏，恢复全部显示
        setHourlyVisible({
          requests: true,
          inputTokens: true,
          outputTokens: true,
          reasoningTokens: true,
          cachedTokens: true,
        });
      } else {
        // 隐藏其他，只显示当前项
        setHourlyVisible({
          requests: key === "requests",
          inputTokens: key === "inputTokens",
          outputTokens: key === "outputTokens",
          reasoningTokens: key === "reasoningTokens",
          cachedTokens: key === "cachedTokens",
        });
      }
    } else {
      // 左键点击：切换当前项
      setHourlyVisible((prev) => ({
        ...prev,
        [key]: !prev[key as string],
      }));
    }
  };

  const TrendLegend: any = Legend;

  const trendConfig = useMemo(() => {
    const defs = {
      requests: { color: darkMode ? "#60a5fa" : "#3b82f6", formatter: (v: any) => formatCompactNumber(v), name: "请求数" },
      tokens: { color: darkMode ? "#4ade80" : "#16a34a", formatter: (v: any) => formatCompactNumber(v), name: "Tokens" },
      cost: { color: "#fbbf24", formatter: (v: any) => formatCurrency(v), name: "费用" },
    };

    const visibleKeys = (Object.keys(trendVisible) as Array<keyof typeof trendVisible>).filter((k) => trendVisible[k]);
    
    // 费用始终使用 cost 轴，避免轴切换导致的重新渲染
    let lineAxisMap: Record<string, string> = {
      requests: "left",
      tokens: "right",
      cost: "cost",
    };
    
    let leftAxisKey = "requests";
    let rightAxisKey = "tokens";
    let rightAxisVisible = true;

    if (visibleKeys.length === 2) {
      if (!trendVisible.requests) {
        // requests 隐藏 -> tokens (left), cost (cost)
        lineAxisMap = { requests: "left", tokens: "left", cost: "cost" };
        leftAxisKey = "tokens";
        rightAxisKey = "tokens";
        rightAxisVisible = false;
      } else if (!trendVisible.tokens) {
        // tokens 隐藏 -> requests (left), cost (cost)
        lineAxisMap = { requests: "left", tokens: "right", cost: "cost" };
        leftAxisKey = "requests";
        rightAxisKey = "requests";
        rightAxisVisible = false;
      } else {
        // cost 隐藏 -> requests (left), tokens (right)
        lineAxisMap = { requests: "left", tokens: "right", cost: "cost" };
        leftAxisKey = "requests";
        rightAxisKey = "tokens";
      }
    } else if (visibleKeys.length === 1) {
      const key = visibleKeys[0];
      lineAxisMap = { requests: "left", tokens: "left", cost: "cost" };
      leftAxisKey = key;
      rightAxisVisible = false;
    } else if (visibleKeys.length === 0) {
       rightAxisVisible = false;
    }

    return {
      lineAxisMap,
      leftAxis: defs[leftAxisKey as keyof typeof defs],
      rightAxis: defs[rightAxisKey as keyof typeof defs],
      rightAxisVisible
    };
  }, [trendVisible, darkMode]);

  const cancelPieLegendClear = useCallback(() => {
    if (pieLegendClearTimerRef.current !== null) {
      window.clearTimeout(pieLegendClearTimerRef.current);
      pieLegendClearTimerRef.current = null;
    }
  }, []);

  const schedulePieLegendClear = useCallback(() => {
    cancelPieLegendClear();
    pieLegendClearTimerRef.current = window.setTimeout(() => {
      setHoveredPieIndex(null);
      pieLegendClearTimerRef.current = null;
    }, 60); // 扇形图例悬停延时，避免缝隙导致频繁闪烁
  }, [cancelPieLegendClear]);

  useEffect(() => {
    if (!pieTooltipOpen) return;

    const isInsideRect = (rect: DOMRect | undefined | null, x: number, y: number) => {
      if (!rect) return false;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    const closeTooltip = () => {
      cancelPieLegendClear();
      setPieTooltipOpen(false);
      setHoveredPieIndex(null);
    };

    const onPointerMove = (e: PointerEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      const mainRect = pieChartContainerRef.current?.getBoundingClientRect();
      const fsRect = pieChartFullscreenContainerRef.current?.getBoundingClientRect();
      const inside = isInsideRect(mainRect, x, y) || isInsideRect(fsRect, x, y);
      if (!inside) closeTooltip();
    };

    const onWindowBlur = () => closeTooltip();

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [pieTooltipOpen, cancelPieLegendClear]);

  // 关闭syncStatus toast
  const closeSyncStatus = useCallback(() => {
    setSyncStatusClosing(true);
    setTimeout(() => {
      setSyncStatus(null);
      setSyncStatusClosing(false);
    }, 400);
  }, []);

  // 关闭saveStatus toast  
  const closeSaveStatus = useCallback(() => {
    setSaveStatusClosing(true);
    setTimeout(() => {
      setSaveStatus(null);
      setSaveStatusClosing(false);
    }, 400);
  }, []);

  // 自动清除 syncStatus toast
  useEffect(() => {
    if (!syncStatus) return;
    
    if (syncStatusTimerRef.current !== null) {
      window.clearTimeout(syncStatusTimerRef.current);
    }
    
    syncStatusTimerRef.current = window.setTimeout(() => {
      closeSyncStatus();
      syncStatusTimerRef.current = null;
    }, 10000);
    
    return () => {
      if (syncStatusTimerRef.current !== null) {
        window.clearTimeout(syncStatusTimerRef.current);
        syncStatusTimerRef.current = null;
      }
    };
  }, [syncStatus, closeSyncStatus]);

  // 自动清除 saveStatus toast
  useEffect(() => {
    if (!saveStatus) return;
    
    if (saveStatusTimerRef.current !== null) {
      window.clearTimeout(saveStatusTimerRef.current);
    }
    
    saveStatusTimerRef.current = window.setTimeout(() => {
      closeSaveStatus();
      saveStatusTimerRef.current = null;
    }, 10000);
    
    return () => {
      if (saveStatusTimerRef.current !== null) {
        window.clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = null;
      }
    };
  }, [saveStatus, closeSaveStatus]);

  // 自动清除 pricesSyncStatus toast - 已禁用
  /*
  useEffect(() => {
    if (pricesSyncStatus.type === 'idle') return;
    
    if (pricesSyncStatusTimerRef.current !== null) {
      window.clearTimeout(pricesSyncStatusTimerRef.current);
    }
    
    pricesSyncStatusTimerRef.current = window.setTimeout(() => {
      setPricesSyncStatus({ type: 'idle' });
      pricesSyncStatusTimerRef.current = null;
    }, 8000);
    
    return () => {
      if (pricesSyncStatusTimerRef.current !== null) {
        window.clearTimeout(pricesSyncStatusTimerRef.current);
        pricesSyncStatusTimerRef.current = null;
      }
    };
  }, [pricesSyncStatus]);
  */

  const applyTheme = useCallback((nextDark: boolean) => {
    setDarkMode(nextDark);
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", nextDark);
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("theme", nextDark ? "dark" : "light");
    }
  }, []);

  // 执行数据同步
  const doSync = useCallback(async (showMessage = true, triggerRefresh = true, timeout = 60000) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncStatus(null);
    try {
      // 创建超时控制器（默认 60 秒，首屏加载时为 5 秒）
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const res = await fetch("/api/sync", { 
        method: "POST", 
        cache: "no-store",
        signal: controller.signal 
      });
      clearTimeout(timeoutId);
      
      const data = await res.json();
      if (!res.ok) {
        const errorMsg = `同步失败: ${data.error || res.statusText}`;
        setSyncStatus(errorMsg);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("lastSyncStatus", errorMsg);
        }
      } else {
        const now = new Date();
        const inserted = data.inserted ?? 0;
        setLastSyncTime(now);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("lastSyncTime", now.toISOString());
        }
        setLastInsertedDelta((prev) => {
          const safePrev = Number.isFinite(prev) ? prev : 0;
          const next = inserted > 0 ? inserted : safePrev;
          if ((inserted > 0 || !Number.isFinite(prev)) && typeof window !== "undefined") {
            window.localStorage.setItem("lastInsertedDelta", String(next));
          }
          return next;
        });
        // 手动同步时总是显示消息，自动同步时仅在有数据时显示
        const shouldShowMessage = showMessage || inserted > 0;
        if (shouldShowMessage) {
          const successMsg = `已同步 ${inserted} 条记录`;
          setSyncStatus(successMsg);
          if (typeof window !== "undefined") {
            window.localStorage.setItem("lastSyncStatus", successMsg);
          }
        }
          if (triggerRefresh && inserted > 0) {
            skipOverviewCacheRef.current = true;
            setRefreshTrigger((prev) => prev + 1);
          }
      }
    } catch (err) {
      // 判断是否为超时错误
      const isTimeout = (err as Error).name === "AbortError";
      const errorMsg = isTimeout 
        ? "同步超时：数据同步可能需要更长时间，建议稍后手动刷新" 
        : `同步失败: ${(err as Error).message}`;
      setSyncStatus(errorMsg);
      if (typeof window !== "undefined") {
        window.localStorage.setItem("lastSyncStatus", errorMsg);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // 加载价格配置
  const loadPrices = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    loadPrices();
  }, [loadPrices]);

  // 同步模型价格
  const syncModelPrices = useCallback(async () => {
    if (syncingPrices) return;

    setSyncingPrices(true);
    // setPricesSyncStatus({ type: 'syncing' }); // 已禁用 toast 通知
    setPricesSyncData(null);
    setPricesSyncModalOpen(true);

    try {
      const res = await fetch("/api/sync-model-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });

      const data = await res.json();
      setPricesSyncData(data);
      
      if (!res.ok) {
        // setPricesSyncStatus({ 
        //   type: 'error', 
        //   message: `价格同步失败: ${data.error || res.statusText}` 
        // }); // 已禁用 toast 通知
      } else {
        const { summary } = data;
        // setPricesSyncStatus({ 
        //   type: 'success', 
        //   message: `已更新 ${summary.updated} 个模型价格，跳过 ${summary.skipped} 个，失败 ${summary.failed} 个`,
        //   summary: summary
        // }); // 已禁用 toast 通知
        // 同步成功后重新加载价格列表
        await loadPrices();
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      // setPricesSyncStatus({ 
      //   type: 'error', 
      //   message: `价格同步失败: ${errorMsg}` 
      // }); // 已禁用 toast 通知
      setPricesSyncData({ error: errorMsg });
    } finally {
      setSyncingPrices(false);
    }
  }, [syncingPrices, loadPrices]);

  // 页面加载时仅在当前会话首次进入时自动同步一次
  useEffect(() => {
    let active = true;
    const autoSyncKey = "cli_dashboard_auto_sync_done";
    const hasSyncedThisSession = typeof window !== "undefined" ? window.sessionStorage.getItem(autoSyncKey) : null;

    if (hasSyncedThisSession) {
      setReady(true);
      return () => {
        active = false;
      };
    }

    const run = async () => {
      try {
        await doSync(true, true, 5000); // 首屏加载使用 5 秒超时
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(autoSyncKey, "1");
        }
      } finally {
        if (active) setReady(true);
      }
    };

    run();

    return () => {
      active = false;
    };
  }, [doSync]);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("theme") : null;
    const prefersDark = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;
    const initial = saved ? saved === "dark" : prefersDark;
    applyTheme(initial);
  }, [applyTheme]);

  useEffect(() => {
    if (!customPickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (customPickerRef.current && !customPickerRef.current.contains(target)) {
        setCustomPickerOpen(false);
        setCustomError(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [customPickerOpen]);

  useEffect(() => {
    if (!ready) return;
    if (rangeMode === "custom" && (!customStart || !customEnd)) return;

    const controller = new AbortController();
    let active = true;

    const loadOverview = async () => {
      setLoadingOverview(true);
      try {
        const params = new URLSearchParams();
        if (rangeMode === "custom") {
          params.set("start", customStart);
          params.set("end", customEnd);
        } else {
          params.set("days", String(rangeDays));
        }
        if (filterModel) params.set("model", filterModel);
        if (filterRoute) params.set("route", filterRoute);
        params.set("page", String(page));
        params.set("pageSize", "500");

        if (skipOverviewCacheRef.current) {
          params.set("skipCache", "1");
          skipOverviewCacheRef.current = false;
        }

        const res = await fetch(`/api/overview?${params.toString()}`, { cache: "no-store", signal: controller.signal });

        if (!res.ok) {
          if (active) {
            setOverviewError("无法加载实时用量：" + res.statusText);
            setOverview(null);
          }
          return;
        }
        const data: OverviewAPIResponse = await res.json();
        if (!active) return;
        setOverview(data.overview ?? null);
        setBucketTimezone(data.timezone);
        setOverviewEmpty(Boolean(data.empty));
        setOverviewError(null);
        setPage(data.meta?.page ?? 1);
        setModelOptions(Array.from(new Set(data.filters?.models ?? [])));
        setRouteOptions(Array.from(new Set(data.filters?.routes ?? [])));
        setAppliedDays(data.days ?? rangeDays);
      } catch (err) {
        if (!active) return;
        const error = err as Error;
        if ((error as any)?.name === "AbortError") return;
        setOverviewError("无法加载实时用量：" + error.message);
        setOverview(null);
      } finally {
        if (active) setLoadingOverview(false);
      }
    };
    loadOverview();
    return () => {
      active = false;
      controller.abort();
    };
  }, [rangeMode, customStart, customEnd, rangeDays, filterModel, filterRoute, page, refreshTrigger, ready]);

  const overviewData = overview;
  const showEmpty = overviewEmpty || !overview;
  
  const hourlySeries = useMemo(() => {
    if (!overviewData?.byHour) return [] as UsageSeriesPoint[];
    if (hourRange === "all") return overviewData.byHour;
    const hours = hourRange === "24h" ? 24 : 72;
    return buildHourlySeries(overviewData.byHour, hours, bucketTimezone);
  }, [hourRange, overviewData?.byHour, bucketTimezone]);

  const hourlyLineStyle = useMemo(
    () => buildHourlyLineStyle(hourlySeries.length, 3),
    [hourlySeries.length]
  );

  const fullscreenHourlyLineStyle = useMemo(
    () => buildHourlyLineStyle(hourlySeries.length, fullscreenHourlyMode === "area" ? 2.3 : 3),
    [hourlySeries.length, fullscreenHourlyMode]
  );

  useEffect(() => {
    if (fullscreenChart === "stacked") {
      setFullscreenHourlyMode("area");
    }
  }, [fullscreenChart]);

  const hourRangeOptions: { key: "all" | "24h" | "72h"; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "24h", label: "最近 24 小时" },
    { key: "72h", label: "最近 72 小时" }
  ];

  // 未配置价格的模型选项（排除已有价格的模型）
  const priceModelOptions = useMemo(() => {
    const configuredModels = new Set(prices.map(p => p.model));
    const allModels = new Set<string>();
    modelOptions.forEach((m) => allModels.add(m));
    overviewData?.models?.forEach((m) => allModels.add(m.model));
    return Array.from(allModels).filter(m => !configuredModels.has(m));
  }, [modelOptions, prices, overviewData?.models]);

  // 已配置价格搜索和宽度计算
  const [priceSearchQuery, setPriceSearchQuery] = useState("");
  const { filteredPrices, badgeWidths } = useMemo(() => {
    const filtered = priceSearchQuery.trim() 
      ? prices.filter(p => p.model.toLowerCase().includes(priceSearchQuery.toLowerCase()))
      : prices;
    
    // 计算全局每列的最大宽度
    if (filtered.length === 0) {
      return { filteredPrices: filtered, badgeWidths: { input: 90, cached: 90, output: 90 } };
    }
    
    const maxInputLen = Math.max(...filtered.map(p => String(p.inputPricePer1M).length));
    const maxCachedLen = Math.max(...filtered.map(p => String(p.cachedInputPricePer1M).length));
    const maxOutputLen = Math.max(...filtered.map(p => String(p.outputPricePer1M).length));
    
    return {
      filteredPrices: filtered,
      badgeWidths: {
        input: Math.max(90, 70 + maxInputLen * 8),
        cached: Math.max(90, 70 + maxCachedLen * 8),
        output: Math.max(90, 70 + maxOutputLen * 8)
      }
    };
  }, [prices, priceSearchQuery]);

  const sortedModelsByCost = useMemo(() => {
    const models = overviewData?.models ?? [];
    return [...models].sort((a, b) => b.cost - a.cost);
  }, [overviewData]);

  // 计算实际数据时长（从最早记录到现在）
  const actualTimeSpan = useMemo(() => {
    if (!overviewData?.byHour || overviewData.byHour.length === 0) {
      return { days: appliedDays, minutes: appliedDays * 24 * 60 };
    }
    
    // 找到最早的时间戳
    let earliestTime: Date | null = null;
    for (const point of overviewData.byHour) {
      if (point.timestamp) {
        const t = new Date(point.timestamp);
        if (Number.isFinite(t.getTime())) {
          if (!earliestTime || t < earliestTime) {
            earliestTime = t;
          }
        }
      }
    }
    
    if (!earliestTime) {
      return { days: appliedDays, minutes: appliedDays * 24 * 60 };
    }
    
    // 计算从最早记录到现在的时长
    const now = new Date();
    const diffMs = now.getTime() - earliestTime.getTime();
    const diffMinutes = Math.max(1, Math.floor(diffMs / (1000 * 60)));
    const diffDays = Math.max(1, diffMinutes / (24 * 60));
    
    return { days: diffDays, minutes: diffMinutes };
  }, [overviewData?.byHour, appliedDays]);

  const rangeSubtitle = useMemo(() => {
    if (rangeMode === "custom" && customStart && customEnd) {
      return `${customStart} ~ ${customEnd}（共 ${appliedDays} 天）`;
    }
    return `最近 ${appliedDays} 天`;
  }, [rangeMode, customStart, customEnd, appliedDays]);


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
      if (statusTimerRef.current !== null) {
        clearTimeout(statusTimerRef.current);
      }
      setStatus("请输入有效的模型名称和单价");
      statusTimerRef.current = window.setTimeout(() => {
        setStatus(null);
        statusTimerRef.current = null;
      }, 10000);
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
        if (statusTimerRef.current !== null) {
          clearTimeout(statusTimerRef.current);
        }
        setStatus("保存失败，请检查后端日志/环境变量");
        statusTimerRef.current = window.setTimeout(() => {
          setStatus(null);
          statusTimerRef.current = null;
        }, 10000);
      } else {
        setPrices((prev: ModelPrice[]) => {
          const others = prev.filter((p) => p.model !== payload.model);
          return [...others, payload].sort((a, b) => a.model.localeCompare(b.model));
        });
        setForm({ model: "", inputPricePer1M: "", cachedInputPricePer1M: "", outputPricePer1M: "" });
        if (statusTimerRef.current !== null) {
          clearTimeout(statusTimerRef.current);
        }
        setStatus("已保存");
        statusTimerRef.current = window.setTimeout(() => {
          setStatus(null);
          statusTimerRef.current = null;
        }, 10000);
        
        // 显示保存成功提示（会被useEffect自动清除）
        setSaveStatus(`已保存价格：${payload.model}`);
        
        // 刷新 overview 数据以更新费用计算
        setRefreshTrigger((prev) => prev + 1);
      }
    } catch (err) {
      if (statusTimerRef.current !== null) {
        clearTimeout(statusTimerRef.current);
      }
      setStatus("请求失败，请稍后重试");
      statusTimerRef.current = window.setTimeout(() => {
        setStatus(null);
        statusTimerRef.current = null;
      }, 10000);
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
      // 如果模型名改变了，先删除旧模型
      if (editingPrice.model !== payload.model) {
        await fetch("/api/prices", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: editingPrice.model })
        });
      }
      
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
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">加载失败</p>
            <p className="text-red-300">{overviewError}</p>
          </div>
        </div>
      ) : null}

      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className={`text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>Usage Dashboard</h1>
          <p className={`text-base ${darkMode ? "text-slate-400" : "text-slate-600"}`}>持久化的 CLIProxyAPI 使用统计与费用分析</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => applyTheme(!darkMode)}
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
                ? darkMode
                  ? "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-500"
                  : "cursor-not-allowed border-slate-300 bg-slate-200 text-slate-500"
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
            {mounted && lastSyncTime && (
              <span className={`text-xs ${darkMode ? "text-slate-500" : "text-slate-500"}`}>
                上次同步: {lastSyncTime.toLocaleTimeString()}
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
              setRangeMode("preset");
              setRangeDays(days);
              setPage(1);
              setCustomPickerOpen(false);
            }}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              rangeMode === "preset" && rangeDays === days
                ? "border-indigo-500 bg-indigo-600 text-white"
                : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
            }`}
          >
            最近 {days} 天
          </button>
        ))}
        <div className="relative" ref={customPickerRef}>
          <button
            onClick={() => {
              setCustomPickerOpen((open) => !open);
              setCustomDraftStart(customStart);
              setCustomDraftEnd(customEnd);
            }}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              rangeMode === "custom"
                ? "border-indigo-500 bg-indigo-600 text-white"
                : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
            }`}
          >
            自定义
          </button>
          {customPickerOpen ? (
            <div
              className={`absolute z-30 mt-2 w-72 rounded-xl border p-4 shadow-2xl ${darkMode ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"}`}
            >
              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-1 gap-2">
                  <label className={darkMode ? "text-slate-300" : "text-slate-700"}>
                    开始日期
                    <input
                      type="date"
                      className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-800 text-white" : "border-slate-300 bg-white text-slate-900"}`}
                      value={customDraftStart}
                      max={customDraftEnd || undefined}
                      onChange={(e) => setCustomDraftStart(e.target.value)}
                    />
                  </label>
                  <label className={darkMode ? "text-slate-300" : "text-slate-700"}>
                    结束日期
                    <input
                      type="date"
                      className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-800 text-white" : "border-slate-300 bg-white text-slate-900"}`}
                      value={customDraftEnd}
                      min={customDraftStart || undefined}
                      onChange={(e) => setCustomDraftEnd(e.target.value)}
                    />
                  </label>
                </div>
                {customError ? (
                  <p className="text-xs text-red-400">{customError}</p>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCustomPickerOpen(false);
                      setCustomError(null);
                      setCustomDraftStart(customStart);
                      setCustomDraftEnd(customEnd);
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ${darkMode ? "text-slate-300 hover:bg-slate-800" : "text-slate-700 hover:bg-slate-100"}`}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!customDraftStart || !customDraftEnd) {
                        setCustomError("请选择开始和结束日期");
                        return;
                      }
                      const startDate = new Date(customDraftStart);
                      const endDate = new Date(customDraftEnd);
                      if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
                        setCustomError("日期无效");
                        return;
                      }
                      if (endDate < startDate) {
                        setCustomError("结束日期需不早于开始日期");
                        return;
                      }
                      setCustomError(null);
                      setCustomStart(customDraftStart);
                      setCustomEnd(customDraftEnd);
                      setRangeMode("custom");
                      setPage(1);
                      setCustomPickerOpen(false);
                      setRefreshTrigger((prev) => prev + 1);
                    }}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    应用
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        {rangeMode === "custom" ? (
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
              darkMode
                ? "border-slate-700 bg-slate-800 text-slate-200 shadow-[0_4px_20px_rgba(15,23,42,0.35)]"
                : "border-slate-200 bg-white text-slate-700 shadow-[0_8px_30px_rgba(15,23,42,0.08)]"
            }`}
          >
            <CalendarRange className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            <span className="whitespace-nowrap">{rangeSubtitle}</span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <ComboBox
            value={filterModelInput}
            onChange={setFilterModelInput}
            options={modelOptions}
            placeholder="按模型过滤"
            darkMode={darkMode}
            onSelectOption={applyModelOption}
            onClear={() => {
              setFilterModelInput("");
              setFilterModel(undefined);
              setPage(1);
            }}
          />
          <ComboBox
            value={filterRouteInput}
            onChange={setFilterRouteInput}
            options={routeOptions}
            placeholder="按 Key 过滤"
            darkMode={darkMode}
            onSelectOption={applyRouteOption}
            onClear={() => {
              setFilterRouteInput("");
              setFilterRoute(undefined);
              setPage(1);
            }}
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
        {/* {showEmpty ? <span className="text-sm text-slate-400">暂无数据，先触发同步</span> : null} */}
      </div>

      {/* 统计卡片 - 单行填满 */}
      <section className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-7">
        {loadingOverview || !overviewData ? (
          <>
            {/* 请求数 skeleton */}
            <Skeleton className="h-28 rounded-2xl" />
            {/* Tokens skeleton - 2列 */}
            <Skeleton className="col-span-2 h-28 rounded-2xl" />
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
            <div className={`animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 ${darkMode ? "bg-slate-800/50 ring-slate-700 hover:shadow-lg hover:shadow-slate-700/30 hover:ring-slate-600" : "bg-white ring-slate-200 hover:shadow-lg hover:ring-slate-300"}`} style={{ animationDelay: '0.05s' }}>
              <div className={`text-sm uppercase tracking-wide ${darkMode ? "text-slate-400" : "text-slate-500"}`}>请求数</div>
              <div className={`mt-3 text-2xl font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>
                {formatNumberWithCommas(overviewData.totalRequests)}
                {lastInsertedDelta > 0 ? (
                  <span className={`ml-2 text-sm font-normal ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                    (+{formatCompactNumber(lastInsertedDelta)})
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm">
                <span className="text-emerald-400">✓ {overviewData.successCount}</span>
                <span className={`mx-2 ${darkMode ? "text-slate-500" : "text-slate-400"}`}>|</span>
                <span className="text-red-400">✗ {overviewData.failureCount}</span>
              </p>
            </div>
            
            {/* Tokens - 占两列 */}
            <div className={`animate-card-float col-span-2 rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 ${darkMode ? "bg-slate-800/50 ring-slate-700 hover:shadow-lg hover:shadow-slate-700/30 hover:ring-slate-600" : "bg-white ring-slate-200 hover:shadow-lg hover:ring-slate-300"}`} style={{ animationDelay: '0.1s' }}>
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
                  <span className="font-medium" style={{ color: darkMode ? "#fb7185" : "#e11d48" }}>{formatNumberWithCommas(overviewData.totalInputTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={darkMode ? "text-slate-400" : "text-slate-500"}>输出</span>
                  <span className="font-medium" style={{ color: darkMode ? "#4ade80" : "#16a34a" }}>{formatNumberWithCommas(overviewData.totalOutputTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={darkMode ? "text-slate-400" : "text-slate-500"}>思考</span>
                  <span className="font-medium" style={{ color: darkMode ? "#fbbf24" : "#d97706" }}>{formatNumberWithCommas(overviewData.totalReasoningTokens)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className={darkMode ? "text-slate-400" : "text-slate-500"}>缓存</span>
                  <span className="font-medium" style={{ color: darkMode ? "#c084fc" : "#9333ea" }}>{formatNumberWithCommas(overviewData.totalCachedTokens)}</span>
                </div>
              </div>
            </div>
            
            {/* 预估费用 */}
            <div className={`animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 ${darkMode ? "bg-gradient-to-br from-amber-500/20 to-amber-700/10 ring-amber-400/40 hover:shadow-lg hover:shadow-amber-500/20 hover:ring-amber-400/60" : "bg-amber-50 ring-amber-200 hover:shadow-lg hover:ring-amber-300"}`} style={{ animationDelay: '0.15s' }}>
              <div className="text-sm uppercase tracking-wide text-amber-400">预估费用</div>
              <div className={`mt-3 text-2xl font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>{formatCurrency(overviewData.totalCost)}</div>
              <p className={`mt-2 text-xs ${darkMode ? "text-amber-300/70" : "text-amber-700/70"}`}>基于模型价格</p>
            </div>

            {/* TPM */}
            <div className={`animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 ${darkMode ? "bg-gradient-to-br from-emerald-600/20 to-emerald-800/10 ring-emerald-500/30 hover:shadow-lg hover:shadow-emerald-500/20 hover:ring-emerald-500/50" : "bg-emerald-50 ring-emerald-200 hover:shadow-lg hover:ring-emerald-300"}`} style={{ animationDelay: '0.2s' }}>
              <div className="text-sm uppercase tracking-wide text-emerald-400">平均 TPM</div>
              <div className={`mt-3 text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>
                {(overviewData.totalTokens / actualTimeSpan.minutes).toFixed(2)}
              </div>
              <p className={`mt-2 text-xs ${darkMode ? "text-emerald-300/70" : "text-emerald-600/70"}`}>每分钟Token</p>
            </div>

            {/* RPM */}
            <div className={`animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 ${darkMode ? "bg-gradient-to-br from-blue-600/20 to-blue-800/10 ring-blue-500/30 hover:shadow-lg hover:shadow-blue-500/20 hover:ring-blue-500/50" : "bg-blue-50 ring-blue-200 hover:shadow-lg hover:ring-blue-300"}`} style={{ animationDelay: '0.25s' }}>
              <div className="text-sm uppercase tracking-wide text-blue-400">平均 RPM</div>
              <div className={`mt-3 text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>
                {(overviewData.totalRequests / actualTimeSpan.minutes).toFixed(2)}
              </div>
              <p className={`mt-2 text-xs ${darkMode ? "text-blue-300/70" : "text-blue-600/70"}`}>每分钟请求</p>
            </div>

            {/* 日均请求 */}
            <div className={`animate-card-float rounded-2xl p-5 shadow-sm ring-1 transition-all duration-200 ${darkMode ? "bg-gradient-to-br from-purple-600/20 to-purple-800/10 ring-purple-500/30 hover:shadow-lg hover:shadow-purple-500/20 hover:ring-purple-500/50" : "bg-purple-50 ring-purple-200 hover:shadow-lg hover:ring-purple-300"}`} style={{ animationDelay: '0.3s' }}>
              <div className="text-sm uppercase tracking-wide text-purple-400">日均请求 (RPD)</div>
              <div className={`mt-3 text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>
                {formatCompactNumber(Math.round(overviewData.totalRequests / actualTimeSpan.days))}
              </div>
              <p className={`mt-2 text-xs ${darkMode ? "text-purple-300/70" : "text-purple-600/70"}`}>每日请求数</p>
            </div>
          </>
        )}
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-5">
        {loadingOverview || !overviewData ? (
          <div className="lg:col-span-3">
            <Skeleton className="h-[400px] rounded-2xl" />
          </div>
        ) : (
          <div className={`animate-card-float rounded-2xl p-6 shadow-sm ring-1 lg:col-span-3 flex flex-col ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`} style={{ animationDelay: '0.15s' }}>
            <div className="flex items-center justify-between">
              <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>每日用量趋势</h2>
              <div className="flex items-center gap-2">
                <span className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>{rangeSubtitle}</span>
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
            <div className="mt-4 flex-1 min-h-64">
              {showEmpty ? (
                <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 text-center">
                  <p className="text-base text-slate-400">暂无图表数据</p>
                  <p className="mt-1 text-sm text-slate-500">请先触发 /api/sync 同步数据</p>
                </div>
              ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={overviewData.byDay} margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#334155" strokeDasharray="5 5" />
                  <XAxis dataKey="label" stroke="#94a3b8" fontSize={12} />
                  <YAxis 
                    yAxisId="left" 
                    stroke={trendConfig.leftAxis.color} 
                    tickFormatter={trendConfig.leftAxis.formatter} 
                    fontSize={12} 
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke={trendConfig.rightAxis.color}
                    tickFormatter={trendConfig.rightAxis.formatter}
                    fontSize={12}
                    hide={!trendConfig.rightAxisVisible}
                  />
                  <YAxis
                    yAxisId="cost"
                    orientation="right"
                    stroke="#fbbf24"
                    tickFormatter={(v) => formatCurrency(v)}
                    fontSize={12}
                    hide={!trendVisible.cost || (trendVisible.requests && trendVisible.tokens)}
                    width={trendVisible.cost && (!trendVisible.requests || !trendVisible.tokens) ? undefined : 0}
                  />
                  <Tooltip 
                    content={({ active, payload, label }) => {
                      if (!active || !payload || !payload.length) return null;
                      const sortedPayload = [...payload].sort((a: any, b: any) => {
                        const order: Record<string, number> = { requests: 0, errors: 1, tokens: 2, cost: 3 };
                        return (order[a.dataKey] ?? 999) - (order[b.dataKey] ?? 999);
                      });
                      return (
                        <div 
                          className="rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm"
                          style={{ 
                            backgroundColor: darkMode ? "rgba(15, 23, 42, 0.7)" : "rgba(255, 255, 255, 0.8)", 
                            border: `1px solid ${darkMode ? "rgba(148, 163, 184, 0.4)" : "rgba(203, 213, 225, 0.6)"}`,
                            color: darkMode ? "#f8fafc" : "#0f172a"
                          }}
                        >
                          <p className={`mb-2 font-medium text-sm ${darkMode ? "text-slate-50" : "text-slate-900"}`}>{label}</p>
                          <div className="space-y-1">
                            {sortedPayload.map((entry: any, index: number) => {
                              let color = entry.color;
                              if (entry.name === "请求数") color = darkMode ? "#60a5fa" : "#3b82f6";
                              if (entry.name === "错误数") color = darkMode ? "#f87171" : "#ef4444";
                              if (entry.name === "Tokens") color = darkMode ? "#4ade80" : "#16a34a";
                              if (entry.name === "费用") color = "#fbbf24";
                              
                              const value = entry.name === "费用" ? formatCurrency(entry.value) : formatNumberWithCommas(entry.value);
                              
                              return (
                                <div key={index} className="flex items-center gap-2 text-sm">
                                  <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                                  <span style={{ color: color }} className="font-medium">
                                    {entry.name}:
                                  </span>
                                  <span className={darkMode ? "text-slate-50" : "text-slate-700"}>
                                    {value}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <TrendLegend 
                    height={24} 
                    iconSize={10} 
                    wrapperStyle={{ paddingTop: 0, paddingBottom: 0, lineHeight: "24px", cursor: "pointer" }} 
                    onClick={handleTrendLegendClick}
                    formatter={(value: string) => {
                      const keyMap: Record<string, string> = { "请求数": "requests", "Tokens": "tokens", "费用": "cost" };
                      const key = keyMap[value];
                      const isVisible = trendVisible[key];
                      if (!isVisible) {
                        return <span style={{ color: darkMode ? "#94a3b8" : "#cbd5e1", textDecoration: "line-through" }}>{value}</span>;
                      }
                      const colors: Record<string, string> = { "请求数": darkMode ? "#60a5fa" : "#3b82f6", "Tokens": darkMode ? "#4ade80" : "#16a34a", "费用": "#fbbf24" };
                      return <span style={{ color: colors[value] || "inherit", fontWeight: 500 }}>{value}</span>;
                    }}
                    itemSorter={(item: any) => ({ requests: 0, tokens: 1, cost: 2 } as Record<string, number>)[item?.dataKey] ?? 999}
                  />
                  <Bar yAxisId={trendConfig.lineAxisMap.requests} dataKey="errors" name="错误数" fill={darkMode ? "#f87171" : "#ef4444"} fillOpacity={0.35} maxBarSize={18} legendType="none" />
                  <Line hide={!trendVisible.requests} yAxisId={trendConfig.lineAxisMap.requests} type="monotone" dataKey="requests" stroke={darkMode ? "#60a5fa" : "#3b82f6"} strokeWidth={2} name="请求数" dot={{ r: 3, fill: darkMode ? "#60a5fa" : "#3b82f6", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
                  <Line hide={!trendVisible.tokens} yAxisId={trendConfig.lineAxisMap.tokens} type="monotone" dataKey="tokens" stroke={darkMode ? "#4ade80" : "#16a34a"} strokeWidth={2} name="Tokens" dot={{ r: 3, fill: darkMode ? "#4ade80" : "#16a34a", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
                  <Line hide={!trendVisible.cost} yAxisId={trendConfig.lineAxisMap.cost} type="monotone" dataKey="cost" stroke="#fbbf24" strokeWidth={2} name="费用" dot={{ r: 3, fill: "#fbbf24", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
                </ComposedChart>
              </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {/* 模型用量饼图 */}
        {loadingOverview || !overviewData ? (
          <div className="lg:col-span-2">
            <Skeleton className="h-[400px] rounded-2xl" />
          </div>
        ) : (
          <div className={`animate-card-float rounded-2xl p-6 shadow-sm ring-1 lg:col-span-2 flex flex-col ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`} style={{ animationDelay: '0.2s' }}>
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
            <div className="mt-4 flex gap-4 h-[300px]">
              {showEmpty || overviewData.models.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 text-center">
                  <p className="text-base text-slate-400">暂无模型数据</p>
                </div>
              ) : (
              <>
                {/* 饼图 */}
                <div
                  ref={pieChartContainerRef}
                  className="shrink-0 w-64"
                  onPointerLeave={() => {
                    cancelPieLegendClear();
                    setPieTooltipOpen(false);
                    setHoveredPieIndex(null);
                  }}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                      <Pie
                        data={overviewData.models}
                        dataKey={pieMode}
                        nameKey="model"
                        cx="50%"
                        cy="50%"
                        outerRadius="85%"
                        innerRadius="45%"
                        animationDuration={500}
                        onMouseEnter={(_, index) => {
                          setHoveredPieIndex(index);
                          setPieTooltipOpen(true);
                        }}
                        onMouseLeave={() => {
                          setHoveredPieIndex(null);
                          setPieTooltipOpen(false);
                        }}
                      >
                        {overviewData.models.map((_, index) => (
                          <Cell 
                            key={`cell-${index}`} 
                            fill={PIE_COLORS[index % PIE_COLORS.length]}
                            fillOpacity={hoveredPieIndex === null || hoveredPieIndex === index ? 1 : 0.3}
                            style={{ transition: 'fill-opacity 0.2s' }}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        position={{ x: 0, y: 0 }}
                        wrapperStyle={{ zIndex: 1000, pointerEvents: "none" }}
                        content={({ active, payload }) => {
                          if (!pieTooltipOpen || hoveredPieIndex === null) return null;
                          if (!active || !payload || !payload[0]) return null;
                          const data = payload[0].payload;
                          return (
                            <div
                              className="rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm"
                              style={{ 
                                backgroundColor: darkMode ? "rgba(15, 23, 42, 0.7)" : "rgba(255, 255, 255, 0.8)", 
                                border: `1px solid ${darkMode ? "rgba(148, 163, 184, 0.4)" : "rgba(203, 213, 225, 0.6)"}`,
                                color: darkMode ? "#f8fafc" : "#0f172a"
                              }}
                            >
                              <p className={`mb-2 font-medium text-sm ${darkMode ? "text-slate-50" : "text-slate-900"}`}>{data.model}</p>
                              <div className="space-y-1">
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="text-blue-400 font-medium">请求数:</span>
                                  <span className={darkMode ? "text-slate-50" : "text-slate-700"}>{formatNumberWithCommas(data.requests)}</span>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="text-emerald-400 font-medium">Tokens:</span>
                                  <span className={darkMode ? "text-slate-50" : "text-slate-700"}>{formatNumberWithCommas(data.tokens)}</span>
                                </div>
                              </div>
                            </div>
                          );
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                {/* 自定义图例 */}
                <div className="flex-1 overflow-y-auto pr-2 space-y-1 custom-scrollbar">
                  {[...overviewData.models]
                    .sort((a, b) => b[pieMode] - a[pieMode])
                    .map((item, sortedIndex) => {
                      const originalIndex = overviewData.models.findIndex(m => m.model === item.model);
                      const total = overviewData.models.reduce((sum, m) => sum + m[pieMode], 0);
                      const percent = total > 0 ? (item[pieMode] / total) * 100 : 0;
                      const isHighlighted = hoveredPieIndex === null || hoveredPieIndex === originalIndex;
                      return (
                        <div 
                          key={item.model} 
                          className={`rounded-lg p-2 transition cursor-pointer ${
                            isHighlighted 
                              ? darkMode ? "bg-slate-700/30" : "bg-slate-100" 
                              : "opacity-40"
                          } ${darkMode ? "hover:bg-slate-700/50" : "hover:bg-slate-200"}`}
                          onMouseEnter={() => {
                            cancelPieLegendClear();
                            setHoveredPieIndex(originalIndex);
                          }}
                          onMouseLeave={() => {
                            schedulePieLegendClear();
                          }}
                          style={{ transition: 'all 0.2s' }}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <div 
                              className={`w-3 h-3 rounded-full shrink-0 transition-all duration-200 ${
                                isHighlighted && hoveredPieIndex === originalIndex ? 'ring-2 ring-offset-1' : ''
                              }`}
                              style={{ 
                                backgroundColor: PIE_COLORS[originalIndex % PIE_COLORS.length],
                                '--tw-ring-color': isHighlighted && hoveredPieIndex === originalIndex ? PIE_COLORS[originalIndex % PIE_COLORS.length] : 'transparent',
                                transform: isHighlighted && hoveredPieIndex === originalIndex ? 'scale(1.2)' : 'scale(1)'
                              } as React.CSSProperties} 
                            />
                            <p className={`text-sm font-medium truncate flex-1 ${darkMode ? "text-slate-200" : "text-slate-800"}`} title={item.model}>
                              {item.model}
                            </p>
                        </div>
                        <div className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-600"} ml-5`}>
                          <span className="font-semibold">{percent.toFixed(1)}%</span>
                          <span className="mx-1.5">·</span>
                          <span>{pieMode === "tokens" ? formatCompactNumber(item.tokens) : formatNumberWithCommas(item.requests)} {pieMode === "tokens" ? "tokens" : "次"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            </div>
          </div>
        )}
      </section>

      {/* 第二行：每小时负载 + 模型费用 */}
      <section className="mt-6 grid gap-6 lg:grid-cols-5">
        {/* 每小时负载分布 */}
        {loadingOverview || !overviewData ? (
          <div className="lg:col-span-3">
            <Skeleton className="h-[400px] rounded-2xl" />
          </div>
        ) : (
          <div className={`animate-card-float rounded-2xl p-6 shadow-sm ring-1 lg:col-span-3 flex flex-col ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`} style={{ animationDelay: '0.25s' }}>
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
            <div className="mt-4 flex-1 min-h-64">
              {showEmpty ? (
                <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-800/30 text-center">
                  <p className="text-base text-slate-400">暂无小时数据</p>
                  <p className="mt-1 text-sm text-slate-500">请先触发 /api/sync 同步数据</p>
                </div>
              ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={hourlySeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradInput" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fca5a5" />
                      <stop offset="100%" stopColor="#f87171" />
                    </linearGradient>
                    <linearGradient id="gradOutput" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#86efac" />
                      <stop offset="100%" stopColor="#4ade80" />
                    </linearGradient>
                    <linearGradient id="gradReasoning" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fcd34d" />
                      <stop offset="100%" stopColor="#fbbf24" />
                    </linearGradient>
                    <linearGradient id="gradCached" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#d8b4fe" />
                      <stop offset="100%" stopColor="#c084fc" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? "#334155" : "#e2e8f0"} />
                  <XAxis dataKey="label" stroke={darkMode ? "#94a3b8" : "#64748b"} fontSize={12} tickFormatter={formatHourLabel} />
                  <YAxis yAxisId="left" stroke={darkMode ? "#60a5fa" : "#3b82f6"} tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                  <YAxis yAxisId="right" orientation="right" stroke={darkMode ? "#94a3b8" : "#64748b"} tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                  <Tooltip 
                    content={({ active, payload, label }) => {
                      if (!active || !payload || !payload.length) return null;
                      const sortedPayload = [...payload].sort((a: any, b: any) => {
                        const order: Record<string, number> = { requests: 0, inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cachedTokens: 4 };
                        return (order[a.dataKey] ?? 999) - (order[b.dataKey] ?? 999);
                      });
                      return (
                        <div 
                          className="rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm"
                          style={{ 
                            backgroundColor: darkMode ? "rgba(15, 23, 42, 0.7)" : "rgba(255, 255, 255, 0.8)", 
                            border: `1px solid ${darkMode ? "rgba(148, 163, 184, 0.4)" : "rgba(203, 213, 225, 0.6)"}`,
                            color: darkMode ? "#f8fafc" : "#0f172a"
                          }}
                        >
                          <p className={`mb-2 font-medium text-sm ${darkMode ? "text-slate-50" : "text-slate-900"}`}>{label ? formatHourLabel(String(label)) : ''}</p>
                          <div className="space-y-1">
                            {sortedPayload.map((entry: any, index: number) => {
                              let color = entry.color;
                              if (entry.name === "输入") color = darkMode ? "#fb7185" : "#e11d48";
                              if (entry.name === "输出") color = darkMode ? "#4ade80" : "#16a34a";
                              if (entry.name === "思考") color = darkMode ? "#fbbf24" : "#d97706";
                              if (entry.name === "缓存") color = darkMode ? "#c084fc" : "#9333ea";
                              if (entry.name === "请求数") color = darkMode ? "#60a5fa" : "#3b82f6";
                              
                              return (
                                <div key={index} className="flex items-center gap-2 text-sm">
                                  <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                                  <span style={{ color: color }} className="font-medium">
                                    {entry.name}:
                                  </span>
                                  <span className={darkMode ? "text-slate-50" : "text-slate-700"}>
                                    {formatNumberWithCommas(entry.value)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <TrendLegend 
                    wrapperStyle={{ cursor: "pointer" }} 
                    onClick={handleHourlyLegendClick}
                    formatter={(value: string) => {
                      const keyMap: Record<string, string> = {
                        "请求数": "requests",
                        "输入": "inputTokens",
                        "输出": "outputTokens",
                        "思考": "reasoningTokens",
                        "缓存": "cachedTokens"
                      };
                      const key = keyMap[value];
                      const isVisible = hourlyVisible[key];
                      
                      if (!isVisible) {
                        return <span style={{ color: darkMode ? "#94a3b8" : "#cbd5e1", textDecoration: "line-through" }}>{value}</span>;
                      }

                      const colors: Record<string, string> = {
                        "请求数": darkMode ? "#60a5fa" : "#3b82f6",
                        "输入": darkMode ? "#fb7185" : "#e11d48",
                        "输出": darkMode ? "#4ade80" : "#16a34a",
                        "思考": darkMode ? "#fbbf24" : "#d97706",
                        "缓存": darkMode ? "#c084fc" : "#9333ea"
                      };
                      return <span style={{ color: colors[value] || "inherit", fontWeight: 500 }} title="按住 Ctrl 点击可只显示该项">{value}</span>;
                    }}
                    itemSorter={(item: any) => ({ requests: 0, inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cachedTokens: 4 } as Record<string, number>)[item?.dataKey] ?? 999}
                    payload={[
                      { value: "请求数", type: "line", id: "requests", color: "#3b82f6", dataKey: "requests" },
                      { value: "输入", type: "square", id: "inputTokens", color: "#e11d48", dataKey: "inputTokens" },
                      { value: "输出", type: "square", id: "outputTokens", color: "#16a34a", dataKey: "outputTokens" },
                      { value: "思考", type: "square", id: "reasoningTokens", color: "#d97706", dataKey: "reasoningTokens" },
                      { value: "缓存", type: "square", id: "cachedTokens", color: "#9333ea", dataKey: "cachedTokens" },
                    ]}
                  />
                  {/* 堆积柱状图 - 柔和配色，仅顶部圆角，增强动画 */}
                  <Bar hide={!hourlyVisible.inputTokens} yAxisId="right" dataKey="inputTokens" name="输入" stackId="tokens" fill="url(#gradInput)" fillOpacity={0.8} animationDuration={600} barSize={24} />
                  <Bar hide={!hourlyVisible.outputTokens} yAxisId="right" dataKey="outputTokens" name="输出" stackId="tokens" fill="url(#gradOutput)" fillOpacity={0.8} animationDuration={600} barSize={24} />
                  <Bar hide={!hourlyVisible.reasoningTokens} yAxisId="right" dataKey="reasoningTokens" name="思考" stackId="tokens" fill="url(#gradReasoning)" fillOpacity={0.8} animationDuration={600} barSize={24} />
                  <Bar hide={!hourlyVisible.cachedTokens} yAxisId="right" dataKey="cachedTokens" name="缓存" stackId="tokens" fill="url(#gradCached)" fillOpacity={0.8} radius={[4, 4, 0, 0]} animationDuration={600} barSize={24} />
                  {/* 曲线在最上层 - 带描边突出显示 */}
                  <Line 
                    hide={!hourlyVisible.requests}
                    yAxisId="left" 
                    type="monotone" 
                    dataKey="requests" 
                    name="请求数" 
                    stroke={darkMode ? "#60a5fa" : "#3b82f6"} 
                    strokeWidth={hourlyLineStyle.strokeWidth}
                    dot={hourlyLineStyle.showDot
                      ? { r: hourlyLineStyle.dotRadius, fill: darkMode ? "#60a5fa" : "#3b82f6", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }
                      : false}
                    activeDot={{ r: hourlyLineStyle.activeDotRadius, stroke: "#fff", strokeWidth: 2 }} 
                  />
                </ComposedChart>
              </ResponsiveContainer>
              )}
            </div>
          </div>
        )}

        {/* 模型费用 */}
        {loadingOverview || !overviewData ? (
          <div className="lg:col-span-2">
            <Skeleton className="h-[400px] rounded-2xl" />
          </div>
        ) : (
          <div className={`animate-card-float rounded-2xl p-6 shadow-sm ring-1 lg:col-span-2 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`} style={{ animationDelay: '0.3s' }}>
            <div className="flex items-center justify-between">
              <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>预估模型费用</h2>
              <span className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>基于配置的价格</span>
            </div>
            <div className="scrollbar-slim mt-3 max-h-80 min-h-[14rem] space-y-2 overflow-y-auto">
              {showEmpty ? (
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
                      {formatNumberWithCommas(model.requests)} 请求数 • {formatCompactNumber(model.tokens)} tokens
                    </p>
                  </div>
                  <div className={`text-base font-semibold ${darkMode ? "text-emerald-400" : "text-emerald-600"}`}>{formatCurrency(model.cost)}</div>
                </div>
              ))
              )}
            </div>
          </div>
        )}
      </section>

      {loadingOverview || !overviewData ? (
        <div className="mt-8">
          <Skeleton className="h-[500px] rounded-2xl" />
        </div>
      ) : (
        <section className={`animate-card-float mt-8 rounded-2xl p-6 shadow-sm ring-1 ${darkMode ? "bg-slate-800/50 ring-slate-700" : "bg-white ring-slate-200"}`} style={{ animationDelay: '0.35s' }}>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className={`text-lg font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>模型价格配置</h2>
              <p className={`text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>设置每百万 tokens 单价，费用计算将立即更新</p>
            </div>
            <div className="flex w-full flex-col gap-4 md:w-3/5 md:flex-row md:items-center md:justify-end">
              <div className="relative w-full md:max-w-[360px]">
                <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${darkMode ? "text-slate-500" : "text-slate-400"}`} />
                <input
                  type="text"
                  placeholder="搜索已配置的模型..."
                  value={priceSearchQuery}
                  onChange={(e) => setPriceSearchQuery(e.target.value)}
                  className={`w-full rounded-lg border py-2 pl-10 pr-3 text-sm focus:border-indigo-500 focus:outline-none ${darkMode ? "border-slate-700 bg-slate-900 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"}`}
                  aria-label="搜索模型价格"
                />
                {priceSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setPriceSearchQuery("")}
                    className={`absolute right-3 top-1/2 -translate-y-1/2 ${darkMode ? "text-slate-500 hover:text-slate-300" : "text-slate-400 hover:text-slate-600"}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <button
                onClick={syncModelPrices}
                disabled={syncingPrices}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  syncingPrices
                    ? darkMode
                      ? "cursor-not-allowed border-slate-700 bg-slate-800 text-slate-500"
                      : "cursor-not-allowed border-slate-300 bg-slate-200 text-slate-500"
                    : "border-emerald-500/50 bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30"
                }`}
                title="从 models.dev 获取最新模型价格并更新到面板"
              >
                <DollarSign className={`h-4 w-4 ${syncingPrices ? "animate-pulse" : ""}`} />
                {syncingPrices ? "同步中..." : "更新价格"}
              </button>
            </div>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-5">
          <form onSubmit={handleSubmit} className={`rounded-xl border p-5 lg:col-span-2 ${darkMode ? "border-slate-700 bg-slate-800/50" : "border-slate-200 bg-slate-50"}`}>
            <div className="grid gap-6">
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
                className="inline-flex items-center justify-center rounded-lg bg-indigo-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-600 disabled:opacity-60"
              >
                <Save className="mr-2 h-4 w-4" />
                {saving ? "保存中..." : "保存价格"}
              </button>
            </div>
          </form>

          <div className="lg:col-span-3">
            <div className="scrollbar-slim grid max-h-[420px] gap-3 overflow-y-auto pr-1">
              {filteredPrices.length ? filteredPrices.map((price) => (
                <div key={price.model} className={`flex items-center justify-between rounded-xl border px-4 py-3 ${darkMode ? "border-slate-700 bg-slate-800/50" : "border-slate-200 bg-slate-50"}`}>
                  <div>
                    <p className={`text-base font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>{price.model}</p>
                    <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
                      <span className={`inline-flex items-center justify-between rounded-full px-2 py-0.5 ${darkMode ? "bg-rose-500/15 text-rose-200" : "bg-rose-100 text-rose-700"}`} style={{ width: `${badgeWidths.input}px` }}>
                        <span>输入</span>
                        <span className="font-semibold tabular-nums">${price.inputPricePer1M}/M</span>
                      </span>
                      <span className={`inline-flex items-center justify-between rounded-full px-2 py-0.5 ${darkMode ? "bg-amber-500/15 text-amber-200" : "bg-amber-100 text-amber-700"}`} style={{ width: `${badgeWidths.cached}px` }}>
                        <span>缓存</span>
                        <span className="font-semibold tabular-nums">${price.cachedInputPricePer1M}/M</span>
                      </span>
                      <span className={`inline-flex items-center justify-between rounded-full px-2 py-0.5 ${darkMode ? "bg-emerald-500/15 text-emerald-200" : "bg-emerald-100 text-emerald-700"}`} style={{ width: `${badgeWidths.output}px` }}>
                        <span>输出</span>
                        <span className="font-semibold tabular-nums">${price.outputPricePer1M}/M</span>
                      </span>
                    </div>
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
                  <p className="text-base text-slate-400">
                    {priceSearchQuery ? "未找到匹配的模型" : "暂无已配置价格"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
        </section>
      )}

      {/* 编辑价格模态框 */}
      <Modal
        isOpen={!!editingPrice}
        onClose={() => setEditingPrice(null)}
        title="编辑价格"
        darkMode={darkMode}
      >
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
      </Modal>

      {/* 删除价格确认模态框 */}
      <Modal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title="确认删除"
        darkMode={darkMode}
      >
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
            className="flex-1 rounded-lg border border-red-400 px-3 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/10"
          >
            确认删除
          </button>
        </div>
      </Modal>

      {/* 全屏图表模态框 */}
      <Modal
        isOpen={!!fullscreenChart}
        onClose={() => setFullscreenChart(null)}
        title={
          fullscreenChart === "stacked" || fullscreenChart === "pie" ? undefined :
          fullscreenChart === "trend" ? "每日请求与 Token 趋势" :
          ""
        }
        darkMode={darkMode}
        className="max-w-6xl"
        backdropClassName="bg-black/70"
      >
        <div className="mt-4 h-[70vh]">
          {fullscreenChart === "trend" && overviewData && (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={overviewData.byDay} margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#334155" strokeDasharray="5 5" />
                <XAxis dataKey="label" stroke="#94a3b8" fontSize={12} />
                <YAxis 
                  yAxisId="left" 
                  stroke={trendConfig.leftAxis.color} 
                  tickFormatter={trendConfig.leftAxis.formatter} 
                  fontSize={12} 
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke={trendConfig.rightAxis.color}
                  tickFormatter={trendConfig.rightAxis.formatter}
                  fontSize={12}
                  hide={!trendConfig.rightAxisVisible}
                />
                <YAxis
                  yAxisId="cost"
                  orientation="right"
                  stroke="#fbbf24"
                  tickFormatter={(v) => formatCurrency(v)}
                  fontSize={12}
                  hide={!trendVisible.cost || (trendVisible.requests && trendVisible.tokens)}
                  width={trendVisible.cost && (!trendVisible.requests || !trendVisible.tokens) ? undefined : 0}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;
                    const sortedPayload = [...payload].sort((a: any, b: any) => {
                      const order: Record<string, number> = { requests: 0, errors: 1, tokens: 2, cost: 3 };
                      return (order[a.dataKey] ?? 999) - (order[b.dataKey] ?? 999);
                    });
                    return (
                      <div 
                        className="rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm"
                        style={{ 
                          backgroundColor: darkMode ? "rgba(15, 23, 42, 0.7)" : "rgba(255, 255, 255, 0.8)", 
                          border: `1px solid ${darkMode ? "rgba(148, 163, 184, 0.4)" : "rgba(203, 213, 225, 0.6)"}`,
                          color: darkMode ? "#f8fafc" : "#0f172a"
                        }}
                      >
                        <p className={`mb-2 font-medium text-sm ${darkMode ? "text-slate-50" : "text-slate-900"}`}>{label}</p>
                        <div className="space-y-1">
                          {sortedPayload.map((entry: any, index: number) => {
                            let color = entry.color;
                            if (entry.name === "请求数") color = darkMode ? "#60a5fa" : "#3b82f6";
                            if (entry.name === "错误数") color = darkMode ? "#f87171" : "#ef4444";
                            if (entry.name === "Tokens") color = darkMode ? "#4ade80" : "#16a34a";
                            if (entry.name === "费用") color = "#fbbf24";
                            
                            const value = entry.name === "费用" ? formatCurrency(entry.value) : formatNumberWithCommas(entry.value);
                            
                            return (
                              <div key={index} className="flex items-center gap-2 text-sm">
                                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                                <span style={{ color: color }} className="font-medium">
                                  {entry.name}:
                                </span>
                                <span className={darkMode ? "text-slate-50" : "text-slate-700"}>
                                  {value}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }}
                />
                <TrendLegend 
                  height={24} 
                  iconSize={10} 
                  wrapperStyle={{ paddingTop: 0, paddingBottom: 0, lineHeight: "24px", cursor: "pointer" }} 
                  onClick={handleTrendLegendClick}
                  formatter={(value: string) => {
                    const keyMap: Record<string, string> = { "请求数": "requests", "Tokens": "tokens", "费用": "cost" };
                    const key = keyMap[value];
                    const isVisible = trendVisible[key];
                    if (!isVisible) {
                      return <span style={{ color: darkMode ? "#94a3b8" : "#cbd5e1", textDecoration: "line-through" }}>{value}</span>;
                    }
                    const colors: Record<string, string> = { "请求数": darkMode ? "#60a5fa" : "#3b82f6", "Tokens": darkMode ? "#4ade80" : "#16a34a", "费用": "#fbbf24" };
                    return <span style={{ color: colors[value] || "inherit", fontWeight: 500 }}>{value}</span>;
                  }}
                  itemSorter={(item: any) => ({ requests: 0, tokens: 1, cost: 2 } as Record<string, number>)[item?.dataKey] ?? 999}
                />
                <Bar yAxisId={trendConfig.lineAxisMap.requests} dataKey="errors" name="错误数" fill={darkMode ? "#f87171" : "#ef4444"} fillOpacity={0.35} maxBarSize={22} legendType="none" />
                <Line hide={!trendVisible.requests} yAxisId={trendConfig.lineAxisMap.requests} type="monotone" dataKey="requests" stroke={darkMode ? "#60a5fa" : "#3b82f6"} strokeWidth={2} name="请求数" dot={{ r: 3, fill: darkMode ? "#60a5fa" : "#3b82f6", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
                <Line hide={!trendVisible.tokens} yAxisId={trendConfig.lineAxisMap.tokens} type="monotone" dataKey="tokens" stroke={darkMode ? "#4ade80" : "#16a34a"} strokeWidth={2} name="Tokens" dot={{ r: 3, fill: darkMode ? "#4ade80" : "#16a34a", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
                <Line hide={!trendVisible.cost} yAxisId={trendConfig.lineAxisMap.cost} type="monotone" dataKey="cost" stroke="#fbbf24" strokeWidth={2} name="费用" dot={{ r: 3, fill: "#fbbf24", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
          {fullscreenChart === "pie" && overviewData && overviewData.models.length > 0 && (
            <div className="flex h-full flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-lg font-semibold text-white">模型用量分布</h3>
                <div className="flex items-center gap-1 pr-5">
                  <button
                    type="button"
                    onClick={() => setPieMode("tokens")}
                    className={`rounded-md border px-2 py-1 text-xs transition ${
                      pieMode === "tokens"
                        ? "border-indigo-500 bg-indigo-600 text-white"
                        : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    Token
                  </button>
                  <button
                    type="button"
                    onClick={() => setPieMode("requests")}
                    className={`rounded-md border px-2 py-1 text-xs transition ${
                      pieMode === "requests"
                        ? "border-indigo-500 bg-indigo-600 text-white"
                        : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    请求数
                  </button>
                </div>
              </div>
              <div className="flex gap-6 flex-1">
                {/* 饼图 */}
                <div
                  ref={pieChartFullscreenContainerRef}
                  className="flex-1"
                  onPointerLeave={() => {
                    cancelPieLegendClear();
                    setPieTooltipOpen(false);
                    setHoveredPieIndex(null);
                  }}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                      <Pie
                        data={overviewData.models}
                        dataKey={pieMode}
                        nameKey="model"
                        cx="50%"
                        cy="50%"
                        outerRadius="75%"
                        innerRadius="40%"
                        animationDuration={500}
                        onMouseEnter={(_, index) => {
                          setHoveredPieIndex(index);
                          setPieTooltipOpen(true);
                        }}
                        onMouseLeave={() => {
                          setHoveredPieIndex(null);
                          setPieTooltipOpen(false);
                        }}
                      >
                        {overviewData.models.map((_, index) => (
                          <Cell 
                            key={`cell-fs-${index}`} 
                            fill={PIE_COLORS[index % PIE_COLORS.length]}
                            fillOpacity={hoveredPieIndex === null || hoveredPieIndex === index ? 1 : 0.3}
                            style={{ transition: 'fill-opacity 0.2s' }}
                          />
                        ))}
                      </Pie>
                      <Tooltip 
                        position={{ x: 0, y: 0 }}
                        wrapperStyle={{ zIndex: 1000, pointerEvents: "none" }}
                        content={({ active, payload }) => {
                          if (!pieTooltipOpen || hoveredPieIndex === null) return null;
                          if (!active || !payload || !payload[0]) return null;
                          const data = payload[0].payload;
                          return (
                            <div
                              className="rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm"
                              style={{ 
                                backgroundColor: darkMode ? "rgba(15, 23, 42, 0.7)" : "rgba(255, 255, 255, 0.8)", 
                                border: `1px solid ${darkMode ? "rgba(148, 163, 184, 0.4)" : "rgba(203, 213, 225, 0.6)"}`,
                                color: darkMode ? "#f8fafc" : "#0f172a"
                              }}
                            >
                              <p className={`mb-2 font-medium text-sm ${darkMode ? "text-slate-50" : "text-slate-900"}`}>{data.model}</p>
                              <div className="space-y-1">
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="text-blue-400 font-medium">请求数:</span>
                                  <span className={darkMode ? "text-slate-50" : "text-slate-700"}>{formatNumberWithCommas(data.requests)}</span>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="text-emerald-400 font-medium">Tokens:</span>
                                  <span className={darkMode ? "text-slate-50" : "text-slate-700"}>{formatNumberWithCommas(data.tokens)}</span>
                                </div>
                              </div>
                            </div>
                          );
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                {/* 自定义图例 */}
                <div className="w-80 overflow-y-auto pr-2 space-y-2 custom-scrollbar">
                  {[...overviewData.models]
                    .sort((a, b) => b[pieMode] - a[pieMode])
                    .map((item) => {
                      const originalIndex = overviewData.models.findIndex(m => m.model === item.model);
                      const total = overviewData.models.reduce((sum, m) => sum + m[pieMode], 0);
                      const percent = total > 0 ? (item[pieMode] / total) * 100 : 0;
                      const isHighlighted = hoveredPieIndex === null || hoveredPieIndex === originalIndex;
                      return (
                        <div 
                          key={item.model} 
                          className={`rounded-lg p-3 transition cursor-pointer ${
                            isHighlighted 
                              ? darkMode ? "bg-slate-700/30" : "bg-slate-100" 
                              : "opacity-40"
                          } ${darkMode ? "hover:bg-slate-700/50" : "hover:bg-slate-200"}`}
                          onMouseEnter={() => {
                            cancelPieLegendClear();
                            setHoveredPieIndex(originalIndex);
                          }}
                          onMouseLeave={() => {
                            schedulePieLegendClear();
                          }}
                          style={{ transition: 'all 0.2s' }}
                        >
                          <div className="flex items-center gap-2 mb-1.5">
                            <div 
                              className={`w-4 h-4 rounded-full shrink-0 transition-all duration-200 ${
                                isHighlighted && hoveredPieIndex === originalIndex ? 'ring-2 ring-offset-1' : ''
                              }`}
                              style={{ 
                                backgroundColor: PIE_COLORS[originalIndex % PIE_COLORS.length],
                                '--tw-ring-color': isHighlighted && hoveredPieIndex === originalIndex ? PIE_COLORS[originalIndex % PIE_COLORS.length] : 'transparent',
                                transform: isHighlighted && hoveredPieIndex === originalIndex ? 'scale(1.2)' : 'scale(1)'
                              } as React.CSSProperties}
                            />
                            <p className={`text-base font-medium truncate flex-1 ${darkMode ? "text-slate-200" : "text-slate-800"}`} title={item.model}>
                              {item.model}
                            </p>
                          </div>
                          <div className={`text-sm ${darkMode ? "text-slate-400" : "text-slate-600"} ml-6`}>
                            <span className="font-semibold">{percent.toFixed(1)}%</span>
                            <span className="mx-1.5">·</span>
                            <span>{pieMode === "tokens" ? formatCompactNumber(item.tokens) : formatNumberWithCommas(item.requests)} {pieMode === "tokens" ? "tokens" : "次"}</span>
                          </div>
                        </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {fullscreenChart === "stacked" && overviewData && (
            <div className="flex h-full flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-white">每小时负载分布</h3>
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
                <div className="flex items-center gap-1 pr-5">
                  <button
                    type="button"
                    onClick={() => setFullscreenHourlyMode("area")}
                    className={`rounded-md border px-2 py-1 text-xs transition ${
                      fullscreenHourlyMode === "area"
                        ? "border-indigo-500 bg-indigo-600 text-white"
                        : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    堆积面积图
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullscreenHourlyMode("bar")}
                    className={`rounded-md border px-2 py-1 text-xs transition ${
                      fullscreenHourlyMode === "bar"
                        ? "border-indigo-500 bg-indigo-600 text-white"
                        : darkMode ? "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                  >
                    堆积柱状图
                  </button>
                </div>
              </div>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={hourlySeries} margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradInputFS" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fca5a5" />
                      <stop offset="100%" stopColor="#f87171" />
                    </linearGradient>
                    <linearGradient id="gradOutputFS" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#86efac" />
                      <stop offset="100%" stopColor="#4ade80" />
                    </linearGradient>
                    <linearGradient id="gradReasoningFS" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fcd34d" />
                      <stop offset="100%" stopColor="#fbbf24" />
                    </linearGradient>
                    <linearGradient id="gradCachedFS" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#d8b4fe" />
                      <stop offset="100%" stopColor="#c084fc" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? "#334155" : "#e2e8f0"} />
                  <XAxis dataKey="label" stroke={darkMode ? "#94a3b8" : "#64748b"} fontSize={12} tickFormatter={formatHourLabel} />
                  <YAxis yAxisId="left" stroke={darkMode ? "#60a5fa" : "#3b82f6"} tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                  <YAxis yAxisId="right" orientation="right" stroke={darkMode ? "#94a3b8" : "#64748b"} tickFormatter={(v) => formatCompactNumber(v)} fontSize={12} />
                  <Tooltip 
                    content={({ active, payload, label }) => {
                      if (!active || !payload || !payload.length) return null;
                      const sortedPayload = [...payload].sort((a: any, b: any) => {
                        const order: Record<string, number> = { requests: 0, inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cachedTokens: 4 };
                        return (order[a.dataKey] ?? 999) - (order[b.dataKey] ?? 999);
                      });
                      return (
                        <div 
                          className="rounded-xl px-4 py-3 shadow-xl backdrop-blur-sm"
                          style={{ 
                            backgroundColor: darkMode ? "rgba(15, 23, 42, 0.7)" : "rgba(255, 255, 255, 0.8)", 
                            border: `1px solid ${darkMode ? "rgba(148, 163, 184, 0.4)" : "rgba(203, 213, 225, 0.6)"}`,
                            color: darkMode ? "#f8fafc" : "#0f172a"
                          }}
                        >
                          <p className={`mb-2 font-medium text-sm ${darkMode ? "text-slate-50" : "text-slate-900"}`}>{label ? formatHourLabel(String(label)) : ''}</p>
                          <div className="space-y-1">
                            {sortedPayload.map((entry: any, index: number) => {
                              let color = entry.color;
                              if (entry.name === "输入") color = darkMode ? "#fb7185" : "#e11d48";
                              if (entry.name === "输出") color = darkMode ? "#4ade80" : "#16a34a";
                              if (entry.name === "思考") color = darkMode ? "#fbbf24" : "#d97706";
                              if (entry.name === "缓存") color = darkMode ? "#c084fc" : "#9333ea";
                              if (entry.name === "请求数") color = darkMode ? "#60a5fa" : "#3b82f6";
                              
                              return (
                                <div key={index} className="flex items-center gap-2 text-sm">
                                  <div className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                                  <span style={{ color: color }} className="font-medium">
                                    {entry.name}:
                                  </span>
                                  <span className={darkMode ? "text-slate-50" : "text-slate-700"}>
                                    {formatNumberWithCommas(entry.value)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <TrendLegend 
                    wrapperStyle={{ cursor: "pointer" }} 
                    onClick={handleHourlyLegendClick}
                    formatter={(value: string) => {
                      const keyMap: Record<string, string> = {
                        "请求数": "requests",
                        "输入": "inputTokens",
                        "输出": "outputTokens",
                        "思考": "reasoningTokens",
                        "缓存": "cachedTokens"
                      };
                      const key = keyMap[value];
                      const isVisible = hourlyVisible[key];
                      
                      if (!isVisible) {
                        return <span style={{ color: darkMode ? "#94a3b8" : "#cbd5e1", textDecoration: "line-through" }}>{value}</span>;
                      }

                      const colors: Record<string, string> = {
                        "请求数": darkMode ? "#60a5fa" : "#3b82f6",
                        "输入": darkMode ? "#fb7185" : "#e11d48",
                        "输出": darkMode ? "#4ade80" : "#16a34a",
                        "思考": darkMode ? "#fbbf24" : "#d97706",
                        "缓存": darkMode ? "#c084fc" : "#9333ea"
                      };
                      return <span style={{ color: colors[value] || "inherit", fontWeight: 500 }} title="按住 Ctrl 点击可只显示该项">{value}</span>;
                    }}
                    itemSorter={(item: any) => ({ requests: 0, inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cachedTokens: 4 } as Record<string, number>)[item?.dataKey] ?? 999}
                    payload={[
                      { value: "请求数", type: "line", id: "requests", color: "#3b82f6", dataKey: "requests" },
                      { value: "输入", type: "square", id: "inputTokens", color: "#e11d48", dataKey: "inputTokens" },
                      { value: "输出", type: "square", id: "outputTokens", color: "#16a34a", dataKey: "outputTokens" },
                      { value: "思考", type: "square", id: "reasoningTokens", color: "#d97706", dataKey: "reasoningTokens" },
                      { value: "缓存", type: "square", id: "cachedTokens", color: "#9333ea", dataKey: "cachedTokens" },
                    ]}
                  />
                  {/* 堆积图层：支持柱状与面积切换 */}
                  {fullscreenHourlyMode === "area" ? (
                    <>
                      <Area hide={!hourlyVisible.inputTokens} yAxisId="right" dataKey="inputTokens" name="输入" stackId="tokens" type="monotone" stroke="#fca5a5" fill="url(#gradInputFS)" fillOpacity={0.35} animationDuration={600} />
                      <Area hide={!hourlyVisible.outputTokens} yAxisId="right" dataKey="outputTokens" name="输出" stackId="tokens" type="monotone" stroke="#4ade80" fill="url(#gradOutputFS)" fillOpacity={0.35} animationDuration={600} />
                      <Area hide={!hourlyVisible.reasoningTokens} yAxisId="right" dataKey="reasoningTokens" name="思考" stackId="tokens" type="monotone" stroke="#fbbf24" fill="url(#gradReasoningFS)" fillOpacity={0.35} animationDuration={600} />
                      <Area hide={!hourlyVisible.cachedTokens} yAxisId="right" dataKey="cachedTokens" name="缓存" stackId="tokens" type="monotone" stroke="#c084fc" fill="url(#gradCachedFS)" fillOpacity={0.35} animationDuration={600} />
                    </>
                  ) : (
                    <>
                      <Bar hide={!hourlyVisible.inputTokens} yAxisId="right" dataKey="inputTokens" name="输入" stackId="tokens" fill="url(#gradInputFS)" fillOpacity={0.8} animationDuration={600} barSize={32} />
                      <Bar hide={!hourlyVisible.outputTokens} yAxisId="right" dataKey="outputTokens" name="输出" stackId="tokens" fill="url(#gradOutputFS)" fillOpacity={0.8} animationDuration={600} barSize={32} />
                      <Bar hide={!hourlyVisible.reasoningTokens} yAxisId="right" dataKey="reasoningTokens" name="思考" stackId="tokens" fill="url(#gradReasoningFS)" fillOpacity={0.8} animationDuration={600} barSize={32} />
                      <Bar hide={!hourlyVisible.cachedTokens} yAxisId="right" dataKey="cachedTokens" name="缓存" stackId="tokens" fill="url(#gradCachedFS)" fillOpacity={0.8} animationDuration={600} barSize={32} />
                    </>
                  )}
                  {/* 曲线在最上层 - 带描边突出显示 */}
                  <Line 
                    hide={!hourlyVisible.requests}
                    yAxisId="left" 
                    type="monotone" 
                    dataKey="requests" 
                    name="请求数" 
                    stroke={darkMode ? "#60a5fa" : "#3b82f6"} 
                    strokeWidth={fullscreenHourlyLineStyle.strokeWidth}
                    strokeOpacity={1}
                    dot={fullscreenHourlyLineStyle.showDot
                      ? { r: fullscreenHourlyLineStyle.dotRadius, fill: darkMode ? "#60a5fa" : "#3b82f6", stroke: "#fff", strokeWidth: 1, fillOpacity: 0.2 }
                      : false}
                    activeDot={{ r: fullscreenHourlyLineStyle.activeDotRadius, stroke: "#fff", strokeWidth: 2 }} 
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </Modal>

      {/* Toast 通知 - 右上角显示 */}
      {syncStatus && (
        <div
          onClick={() => closeSyncStatus()}
          className={`fixed right-6 top-24 z-50 max-w-[290px] cursor-pointer rounded-lg border px-4 py-3 shadow-lg transition-opacity hover:opacity-90 ${
            syncStatusClosing ? "animate-toast-out" : "animate-toast-in"
          } ${
            syncStatus.includes("失败") || syncStatus.includes("超时")
              ? darkMode
                ? "border-rose-500/30 bg-rose-950/60 text-rose-200"
                : "border-rose-300 bg-rose-50 text-rose-800"
              : darkMode
              ? "border-green-500/40 bg-green-900/80 text-green-100"
              : "border-green-400 bg-green-50 text-green-900"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xl animate-emoji-pop">
              {syncStatus.includes("失败") || syncStatus.includes("超时") ? "❌" : "✅"}
            </span>
            <span className="text-sm font-medium">{syncStatus}</span>
          </div>
        </div>
      )}

      {saveStatus && (
        <div
          onClick={() => closeSaveStatus()}
          className={`fixed right-6 top-36 z-50 max-w-[290px] cursor-pointer rounded-lg border px-4 py-3 shadow-lg transition-opacity hover:opacity-90 ${
            saveStatusClosing ? "animate-toast-out" : "animate-toast-in"
          } ${
            darkMode
              ? "border-green-500/40 bg-green-900/80 text-green-100"
              : "border-green-400 bg-green-50 text-green-900"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xl animate-emoji-pop">✅</span>
            <span className="text-sm font-medium">{saveStatus}</span>
          </div>
        </div>
      )}

      {/* TODO: 价格同步 toast 通知已禁用，详情请查看弹窗
      {pricesSyncStatus.type !== 'idle' && (
        <div
          onClick={() => setPricesSyncStatus({ type: 'idle' })}
          className={`fixed right-6 top-48 z-50 max-w-[340px] cursor-pointer rounded-lg border px-4 py-3 shadow-lg transition-opacity hover:opacity-90 animate-toast-in ${
            pricesSyncStatus.type === 'error'
              ? darkMode
                ? "border-rose-500/30 bg-rose-950/60 text-rose-200"
                : "border-rose-300 bg-rose-50 text-rose-800"
              : darkMode
              ? "border-emerald-500/40 bg-emerald-900/80 text-emerald-100"
              : "border-emerald-400 bg-emerald-50 text-emerald-900"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-xl animate-emoji-pop">
              {pricesSyncStatus.type === 'error' ? "💰" : pricesSyncStatus.type === 'syncing' ? "⏳" : "✅"}
            </span>
            <span className="text-sm font-medium">
              {pricesSyncStatus.type === 'syncing' 
                ? (pricesSyncStatus.message || '正在同步...') 
                : pricesSyncStatus.message
              }
            </span>
          </div>
        </div>
      )}
      */}

      {/* 模型价格同步详情弹窗 */}
      <Modal
        isOpen={pricesSyncModalOpen}
        onClose={() => setPricesSyncModalOpen(false)}
        title="模型价格同步详情"
        darkMode={darkMode}
        className="max-w-3xl"
      >
        <div className="max-h-[70vh] overflow-auto">
          {syncingPrices && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500"></div>
              <span className={`ml-4 text-base ${darkMode ? "text-slate-300" : "text-slate-600"}`}>正在同步价格...</span>
            </div>
          )}
          
          {pricesSyncData && !syncingPrices && (
            <>
              {/* 错误信息优先显示 */}
              {pricesSyncData.error && (
                <div className={`rounded-xl p-6 border-2 ${darkMode ? "bg-red-950/30 border-red-500/40" : "bg-red-50 border-red-300"}`}>
                  <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 p-2 rounded-lg ${darkMode ? "bg-red-900/40" : "bg-red-200"}`}>
                      <AlertTriangle className={`h-6 w-6 ${darkMode ? "text-red-400" : "text-red-600"}`} />
                    </div>
                    <div className="flex-1">
                      <h3 className={`text-lg font-semibold mb-2 ${darkMode ? "text-red-300" : "text-red-900"}`}>
                        同步失败
                      </h3>
                      <p className={`text-sm leading-relaxed ${darkMode ? "text-red-200/90" : "text-red-800"}`}>
                        {pricesSyncData.error}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* 摘要 */}
              {pricesSyncData.summary && !pricesSyncData.error && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className={`rounded-xl border p-4 ${darkMode ? "bg-slate-800/50 border-slate-700" : "bg-slate-50 border-slate-200"}`}>
                      <p className={`text-xs mb-1 ${darkMode ? "text-slate-400" : "text-slate-500"}`}>总计</p>
                      <p className={`text-2xl font-bold ${darkMode ? "text-white" : "text-slate-900"}`}>{pricesSyncData.summary.total}</p>
                    </div>
                    <div className="rounded-xl border p-4 bg-emerald-500/10 border-emerald-500/30">
                      <p className="text-xs mb-1 text-emerald-400">已更新</p>
                      <p className="text-2xl font-bold text-emerald-400">{pricesSyncData.summary.updated}</p>
                    </div>
                    <div className="rounded-xl border p-4 bg-yellow-500/10 border-yellow-500/30">
                      <p className="text-xs mb-1 text-yellow-400">跳过</p>
                      <p className="text-2xl font-bold text-yellow-400">{pricesSyncData.summary.skipped}</p>
                    </div>
                    <div className="rounded-xl border p-4 bg-red-500/10 border-red-500/30">
                      <p className="text-xs mb-1 text-red-400">失败</p>
                      <p className="text-2xl font-bold text-red-400">{pricesSyncData.summary.failed}</p>
                    </div>
                  </div>

                  {/* 详细结果 */}
                  {pricesSyncData.details && pricesSyncData.details.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className={`border-b ${darkMode ? "border-slate-700" : "border-slate-300"}`}>
                        <th className="py-2 px-2 text-left">模型</th>
                        <th className="py-2 px-2 text-left">状态</th>
                        <th className="py-2 px-2 text-left">匹配到</th>
                        <th className="py-2 px-2 text-left">原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pricesSyncData.details.map((d, i) => (
                        <tr key={i} className={`border-b ${darkMode ? "border-slate-700/50" : "border-slate-200"}`}>
                          <td className="py-1.5 px-2 font-mono">{d.model}</td>
                          <td className="py-1.5 px-2">
                            <span className={`inline-flex items-center justify-center w-6 h-4.5 rounded text-xs ${
                              d.status === "updated" ? "bg-emerald-500/20 text-emerald-400" :
                              d.status === "skipped" ? "bg-yellow-500/20 text-yellow-400" :
                              "bg-red-500/20 text-red-400"
                            }`}>
                              {d.status === "updated" ? "✓" : d.status === "skipped" ? "⊘" : "✗"}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 font-mono text-emerald-400">{d.matchedWith || "-"}</td>
                          <td className="py-1.5 px-2 text-slate-500 max-w-xs truncate" title={d.reason}>
                            {d.reason || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </main>
  );
}

function StatCard({ label, value, hint, subValue, icon: Icon }: { label: string; value: string; hint?: string; subValue?: string; icon?: LucideIcon }) {
  return (
    <div className="rounded-2xl bg-slate-800/50 p-5 shadow-sm ring-1 ring-slate-700 transition-all duration-200 hover:shadow-lg hover:shadow-slate-700/30 hover:ring-slate-600">
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
  onSelectOption,
  onClear
}: {
  value: string;
  onChange: (val: string) => void;
  options: string[];
  placeholder?: string;
  darkMode: boolean;
  className?: string;
  onSelectOption?: (val: string) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [hasTyped, setHasTyped] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  
  const filtered = useMemo(() => {
    if (!hasTyped) return options;
    return options.filter((opt) => opt.toLowerCase().includes(value.toLowerCase()));
  }, [hasTyped, options, value]);

  const baseInput = `${className ?? ""} rounded-lg border px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none ${
    darkMode ? "border-slate-700 bg-slate-800 text-white placeholder-slate-500" : "border-slate-300 bg-white text-slate-900 placeholder-slate-400"
  }`;

  const closeDropdown = () => {
    setIsClosing(true);
    setTimeout(() => {
      setOpen(false);
      setIsVisible(false);
      setIsClosing(false);
    }, 100); // Match animation duration
  };

  useEffect(() => {
    if (open) {
      // Use requestAnimationFrame to ensure DOM is ready before starting animation
      requestAnimationFrame(() => {
        startTransition(() => {
          setIsVisible(true);
          setIsClosing(false);
        });
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
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
        placeholder={placeholder}
        className={`${baseInput} pr-8`}
      />
      {value && (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent input from focusing
          }}
          onClick={() => {
            onChange("");
            setHasTyped(false);
            onClear?.();
          }}
          className={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition ${
            darkMode ? "text-slate-400 hover:bg-slate-700 hover:text-slate-200" : "text-slate-500 hover:bg-slate-200 hover:text-slate-700"
          }`}
          title="清除"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {isVisible && filtered.length > 0 ? (
        <div
          className={`absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-xl border shadow-lg scrollbar-slim ${
            darkMode ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"
          } ${isClosing ? "animate-dropdown-out" : "animate-dropdown-in"}`}
        >
          {filtered.map((opt) => (
            <button
              type="button"
              key={opt}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(opt);
                setHasTyped(false);
                closeDropdown();
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
