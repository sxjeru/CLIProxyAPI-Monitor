"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, RefreshCw, SlidersHorizontal, X, CalendarRange } from "lucide-react";
import { formatNumberWithCommas } from "@/lib/utils";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { enUS, ja, ko, zhCN } from "date-fns/locale";

type UsageRecord = {
  id: number;
  occurredAt: string;
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

type RecordsResponse = {
  items: UsageRecord[];
  nextCursor: string | null;
  filters?: { models: string[]; routes: string[] };
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

const PAGE_SIZE = 60;
const TOKEN_COLORS = {
  input: "#fb7185",
  output: "#4ade80",
  reasoning: "#fbbf24",
  cached: "#c084fc"
};

function formatTimestamp(ts: string) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "-";
  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleString("zh-CN", {
    year: includeYear ? "2-digit" : undefined,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  });
}

function formatCost(value: number) {
  return `$${value.toFixed(5)}`;
}

function formatDateInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeDisplay(value: string) {
  if (!value) return value;
  return value.replace("T", " ");
}

function parseDateTimeInput(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const time = value.includes("T") ? value.split("T")[1] ?? "00:00" : "00:00";
  return { date, time };
}

function SkeletonRow() {
  return (
    <div className="animate-pulse rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="h-3 w-1/3 rounded bg-slate-700/60" />
      <div className="mt-3 h-3 w-2/3 rounded bg-slate-700/60" />
    </div>
  );
}

function SortHeader({
  label,
  active,
  order,
  onClick
}: {
  label: string;
  active: boolean;
  order: SortOrder;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 font-semibold transition ${active ? "text-white" : "text-slate-300 hover:text-white"}`}
    >
      <span>{label}</span>
      {active ? (
        order === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />
      ) : null}
    </button>
  );
}

export default function RecordsPage() {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [models, setModels] = useState<string[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [routeInput, setRouteInput] = useState("");
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [rangePickerOpen, setRangePickerOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>(undefined);
  const [timeStart, setTimeStart] = useState("00:00");
  const [timeEnd, setTimeEnd] = useState("23:59");
  const [rangeError, setRangeError] = useState<string | null>(null);
  const rangePickerRef = useRef<HTMLDivElement | null>(null);

  const [appliedModel, setAppliedModel] = useState<string>("");
  const [appliedRoute, setAppliedRoute] = useState<string>("");
  const [appliedStart, setAppliedStart] = useState<string>("");
  const [appliedEnd, setAppliedEnd] = useState<string>("");

  const [sortField, setSortField] = useState<SortField>("occurredAt");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const isEmpty = !loading && records.length === 0;
  const loadingEmpty = loading && records.length === 0;

  const buildParams = useCallback(
    (cursorValue?: string | null, includeFilters?: boolean) => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("sortField", sortField);
      params.set("sortOrder", sortOrder);
      if (cursorValue) params.set("cursor", cursorValue);
      if (appliedModel) params.set("model", appliedModel);
      if (appliedRoute) params.set("route", appliedRoute);
      if (appliedStart) params.set("start", new Date(appliedStart).toISOString());
      if (appliedEnd) params.set("end", new Date(appliedEnd).toISOString());
      if (includeFilters) params.set("includeFilters", "1");
      return params;
    },
    [sortField, sortOrder, appliedModel, appliedRoute, appliedStart, appliedEnd]
  );

  const fetchRecords = useCallback(
    async (opts: { cursor?: string | null; append?: boolean; includeFilters?: boolean } = {}) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const params = buildParams(opts.cursor, opts.includeFilters);
        const res = await fetch(`/api/records?${params.toString()}`, { cache: "no-store" });
        const data: RecordsResponse & { error?: string } = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        setCursor(data.nextCursor ?? null);
        setHasMore(Boolean(data.nextCursor));
        setRecords((prev) => (opts.append ? [...prev, ...data.items] : data.items));
        if (data.filters?.models?.length) {
          setModels(data.filters.models);
        }
        if (data.filters?.routes?.length) {
          setRoutes(data.filters.routes);
        }
      } catch (err) {
        setError((err as Error).message || "加载失败");
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [buildParams]
  );

  const resetAndFetch = useCallback(
    (includeFilters?: boolean) => {
      setRecords([]);
      setCursor(null);
      setHasMore(true);
      fetchRecords({ cursor: null, append: false, includeFilters });
    },
    [fetchRecords]
  );

  useEffect(() => {
    resetAndFetch(true);
  }, [resetAndFetch]);

  useEffect(() => {
    if (!sentinelRef.current) return;
    if (!hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && hasMore && !loadingRef.current) {
          fetchRecords({ cursor, append: true });
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [cursor, fetchRecords, hasMore, loading]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  useEffect(() => {
    resetAndFetch(false);
  }, [sortField, sortOrder, resetAndFetch]);

  const applyFilters = (overrides?: { model?: string; route?: string; start?: string; end?: string }) => {
    const nextModel = (overrides?.model ?? modelInput).trim();
    const nextRoute = (overrides?.route ?? routeInput).trim();
    const nextStart = overrides?.start ?? startInput;
    const nextEnd = overrides?.end ?? endInput;
    setAppliedModel(nextModel);
    setAppliedRoute(nextRoute);
    setAppliedStart(nextStart);
    setAppliedEnd(nextEnd);
  };

  const applyModelOption = (val: string) => {
    setModelInput(val);
    setAppliedModel(val.trim());
  };

  const applyRouteOption = (val: string) => {
    setRouteInput(val);
    setAppliedRoute(val.trim());
  };

  useEffect(() => {
    resetAndFetch(false);
  }, [appliedModel, appliedRoute, appliedStart, appliedEnd, resetAndFetch]);

  const costTone = useCallback((cost: number) => {
    if (cost >= 5) return "bg-red-500/20 text-red-300 ring-1 ring-red-500/40";
    if (cost >= 1) return "bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/40";
    if (cost > 0) return "bg-emerald-400/20 text-emerald-200 ring-1 ring-emerald-400/40";
    return "bg-slate-700/60 text-slate-300 ring-1 ring-slate-600";
  }, []);

  const statusTone = useCallback((isError: boolean) => {
    return isError
      ? "bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/40"
      : "bg-sky-500/20 text-sky-200 ring-1 ring-sky-500/40";
  }, []);

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (appliedModel) parts.push(`模型: ${appliedModel}`);
    if (appliedRoute) parts.push(`密钥: ${appliedRoute}`);
    if (appliedStart || appliedEnd) {
      const startLabel = appliedStart ? formatDateTimeDisplay(appliedStart) : "-";
      const endLabel = appliedEnd ? formatDateTimeDisplay(appliedEnd) : "-";
      parts.push(`时间: ${startLabel} ~ ${endLabel}`);
    }
    return parts.length ? parts.join(" / ") : "暂无筛选";
  }, [appliedModel, appliedRoute, appliedStart, appliedEnd]);

  const rangeLabel = useMemo(() => {
    if (!startInput && !endInput) return "选择时间范围";
    const startLabel = startInput ? formatDateTimeDisplay(startInput) : "-";
    const endLabel = endInput ? formatDateTimeDisplay(endInput) : "-";
    return `${startLabel} ~ ${endLabel}`;
  }, [startInput, endInput]);

  const dayPickerLocale = useMemo(() => {
    if (typeof navigator === "undefined") return zhCN;
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) return zhCN;
    if (lang.startsWith("ja")) return ja;
    if (lang.startsWith("ko")) return ko;
    return enUS;
  }, []);

  const dayPickerClassNames = useMemo(
    () => ({
      months: "flex flex-col gap-2",
      month: "space-y-2",
      caption: "flex items-center justify-between px-2 py-2 text-sm text-slate-200",
      caption_label: "text-sm font-semibold text-slate-100",
      nav: "flex items-center gap-2",
      nav_button: "h-7 w-7 rounded-md text-slate-300 hover:bg-slate-800/80",
      nav_button_previous: "hover:bg-slate-800/80",
      nav_button_next: "hover:bg-slate-800/80",
      table: "w-full border-separate border-spacing-y-2",
      head_row: "text-xs text-slate-500",
      head_cell: "pb-1",
      tbody: "",
      row: "w-full",
      cell: "p-0",
      day: "h-8 w-full text-sm text-slate-200 hover:!bg-indigo-500 hover:!text-white rounded-none hover:!rounded-md relative z-10 transition-all",
      day_today: "text-indigo-300 font-semibold",
      day_selected: "!bg-indigo-500 !text-white font-semibold rounded-none hover:!bg-indigo-600 hover:!text-white",
      day_range_start: "!bg-indigo-500 !text-white font-semibold !rounded-l-lg hover:!bg-indigo-600 hover:!text-white",
      day_range_end: "!bg-indigo-500 !text-white font-semibold !rounded-r-lg hover:!bg-indigo-600 hover:!text-white",
      day_range_middle: "!bg-indigo-500/25 !text-indigo-100 rounded-none hover:!bg-indigo-500/40 hover:!text-white hover:!rounded-none",
      day_outside: "text-slate-600",
      day_disabled: "text-slate-600"
    }),
    []
  );

  useEffect(() => {
    if (!rangePickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rangePickerRef.current && !rangePickerRef.current.contains(target)) {
        setRangePickerOpen(false);
        setRangeError(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [rangePickerOpen]);

  return (
    <main className="min-h-screen bg-slate-900 px-6 py-8 text-slate-100">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">调用记录</h1>
          <p className="text-base text-slate-400">展示模型调用明细，支持筛选与排序</p>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <button
            onClick={() => resetAndFetch(false)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-semibold hover:border-slate-500"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </div>
      </header>

      <section className="mt-4 rounded-2xl bg-slate-800/50 p-4 shadow-sm ring-1 ring-slate-700">
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-slate-400" />
            <span>筛选</span>
          </div>

          <ComboBox
            value={modelInput}
            onChange={setModelInput}
            options={models}
            placeholder="按模型过滤"
            darkMode={true}
            onSelectOption={applyModelOption}
            onClear={() => {
              setModelInput("");
              setAppliedModel("");
            }}
          />
          <ComboBox
            value={routeInput}
            onChange={setRouteInput}
            options={routes}
            placeholder="按 Key 过滤"
            darkMode={true}
            onSelectOption={applyRouteOption}
            onClear={() => {
              setRouteInput("");
              setAppliedRoute("");
            }}
          />

          <div className="relative" ref={rangePickerRef}>
            <button
              type="button"
              onClick={() => {
                const start = parseDateTimeInput(startInput);
                const end = parseDateTimeInput(endInput);
                if (start && end) {
                  setRange({ from: start.date, to: end.date });
                  setTimeStart(start.time ?? "00:00");
                  setTimeEnd(end.time ?? "23:59");
                } else if (start) {
                  setRange({ from: start.date, to: start.date });
                  setTimeStart(start.time ?? "00:00");
                } else if (end) {
                  setRange({ from: end.date, to: end.date });
                  setTimeEnd(end.time ?? "23:59");
                } else {
                  setRange(undefined);
                  setTimeStart("00:00");
                  setTimeEnd("23:59");
                }
                setRangeError(null);
                setRangePickerOpen((prev) => !prev);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:border-slate-500"
            >
              <CalendarRange className="h-4 w-4 text-indigo-400" />
              <span className="whitespace-nowrap">{rangeLabel}</span>
            </button>

            {rangePickerOpen ? (
              <div className="absolute left-0 z-20 mt-2 min-w-[320px] w-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-lg">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2">
                  <DayPicker
                    mode="range"
                    selected={range}
                    onSelect={setRange}
                    numberOfMonths={1}
                    locale={dayPickerLocale}
                    className="rdp rdp-dark text-slate-200"
                    classNames={dayPickerClassNames}
                  />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="block text-xs text-slate-400">
                    开始时间
                    <input
                      type="time"
                      value={timeStart}
                      onChange={(e) => setTimeStart(e.target.value)}
                      className="mt-1 w-auto min-w-[120px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    结束时间
                    <input
                      type="time"
                      value={timeEnd}
                      onChange={(e) => setTimeEnd(e.target.value)}
                      className="mt-1 w-auto min-w-[120px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                </div>
                {rangeError ? <p className="text-xs text-red-400">{rangeError}</p> : null}
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRangePickerOpen(false);
                      setRangeError(null);
                    }}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!range?.from || !range?.to) {
                        setRangeError("请选择开始和结束时间");
                        return;
                      }
                      if (range.to < range.from) {
                        setRangeError("结束时间需不早于开始时间");
                        return;
                      }
                      if (!/^\d{2}:\d{2}$/.test(timeStart) || !/^\d{2}:\d{2}$/.test(timeEnd)) {
                        setRangeError("时间格式无效");
                        return;
                      }
                      setRangeError(null);
                      const startValue = `${formatDateInput(range.from)}T${timeStart}`;
                      const endValue = `${formatDateInput(range.to)}T${timeEnd}`;
                      setStartInput(startValue);
                      setEndInput(endValue);
                      applyFilters({ start: startValue, end: endValue });
                      setRangePickerOpen(false);
                    }}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    应用
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setModelInput("");
                setRouteInput("");
                setStartInput("");
                setEndInput("");
                setAppliedModel("");
                setAppliedRoute("");
                setAppliedStart("");
                setAppliedEnd("");
              }}
              className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-1.5 text-sm font-semibold text-slate-300 hover:border-slate-500"
            >
              重置
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">当前筛选：{filterSummary}</p>
      </section>

      <section className={`mt-5 rounded-2xl bg-slate-800/40 p-4 shadow-sm ring-1 ring-slate-700 ${loadingEmpty ? "min-h-[100vh]" : ""}`}>
        <div className="overflow-auto">
          <table className="min-w-[1200px] w-[99%] mx-auto table-fixed border-separate border-spacing-y-2">
            <thead className="sticky top-0 z-10">
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="px-3 py-2 w-40">
                  <SortHeader
                    label="时间"
                    active={sortField === "occurredAt"}
                    order={sortOrder}
                    onClick={() => handleSort("occurredAt")}
                  />
                </th>
                <th className="px-3 py-2 w-60">
                  <SortHeader
                    label="模型"
                    active={sortField === "model"}
                    order={sortOrder}
                    onClick={() => handleSort("model")}
                  />
                </th>
                <th className="px-3 py-2 w-52">
                  <SortHeader
                    label="密钥"
                    active={sortField === "route"}
                    order={sortOrder}
                    onClick={() => handleSort("route")}
                  />
                </th>
                <th className="px-3 py-2 w-28">
                  <SortHeader
                    label="Tokens"
                    active={sortField === "totalTokens"}
                    order={sortOrder}
                    onClick={() => handleSort("totalTokens")}
                  />
                </th>
                <th className="px-3 py-2 w-24">
                  <SortHeader
                    label="输入"
                    active={sortField === "inputTokens"}
                    order={sortOrder}
                    onClick={() => handleSort("inputTokens")}
                  />
                </th>
                <th className="px-3 py-2 w-24">
                  <SortHeader
                    label="输出"
                    active={sortField === "outputTokens"}
                    order={sortOrder}
                    onClick={() => handleSort("outputTokens")}
                  />
                </th>
                <th className="px-3 py-2 w-24">
                  <SortHeader
                    label="思考"
                    active={sortField === "reasoningTokens"}
                    order={sortOrder}
                    onClick={() => handleSort("reasoningTokens")}
                  />
                </th>
                <th className="px-3 py-2 w-24">
                  <SortHeader
                    label="缓存"
                    active={sortField === "cachedTokens"}
                    order={sortOrder}
                    onClick={() => handleSort("cachedTokens")}
                  />
                </th>
                <th className="px-3 py-2 w-28">
                  <SortHeader
                    label="费用"
                    active={sortField === "cost"}
                    order={sortOrder}
                    onClick={() => handleSort("cost")}
                  />
                </th>
                <th className="px-3 py-2 w-20">
                  <SortHeader
                    label="状态"
                    active={sortField === "isError"}
                    order={sortOrder}
                    onClick={() => handleSort("isError")}
                  />
                </th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {records.map((row) => (
                <tr
                  key={row.id}
                  className="rounded-lg bg-slate-900/70 text-slate-100 shadow-sm ring-1 ring-slate-800 transition hover:ring-2 hover:ring-indigo-400/60 hover:shadow-[0_0_12px_rgba(99,102,241,0.35)] h-13"
                >
                  <td className="px-3 py-3 whitespace-nowrap first:rounded-l-lg last:rounded-r-lg">
                    <div className="text-sm font-semibold text-white">{formatTimestamp(row.occurredAt)}</div>
                    {/* <div className="mt-1 text-xs text-slate-500">ID #{row.id}</div> */}
                  </td>
                  <td className="px-3 py-3 first:rounded-l-lg last:rounded-r-lg">
                    <div className="max-w-[220px] truncate font-semibold text-white" title={row.model}>
                      {row.model}
                    </div>
                  </td>
                  <td className="px-3 py-3 first:rounded-l-lg last:rounded-r-lg">
                    <div className="max-w-[200px] truncate text-slate-300" title={row.route}>
                      {row.route}
                    </div>
                  </td>
                  <td className="px-3 py-3 first:rounded-l-lg last:rounded-r-lg">
                    <span className="rounded-full bg-indigo-500/20 px-2.5 py-1 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-500/30">
                      {formatNumberWithCommas(row.totalTokens)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-sm first:rounded-l-lg last:rounded-r-lg">
                    <span className="font-medium" style={{ color: TOKEN_COLORS.input }}>
                      {formatNumberWithCommas(row.inputTokens)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-sm first:rounded-l-lg last:rounded-r-lg">
                    <span className="font-medium" style={{ color: TOKEN_COLORS.output }}>
                      {formatNumberWithCommas(row.outputTokens)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-sm first:rounded-l-lg last:rounded-r-lg">
                    <span className="font-medium" style={{ color: TOKEN_COLORS.reasoning }}>
                      {formatNumberWithCommas(row.reasoningTokens)}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-sm first:rounded-l-lg last:rounded-r-lg">
                    <span className="font-medium" style={{ color: TOKEN_COLORS.cached }}>
                      {formatNumberWithCommas(row.cachedTokens)}
                    </span>
                  </td>
                  <td className="px-3 py-3 first:rounded-l-lg last:rounded-r-lg">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${costTone(row.cost)}`}>
                      {formatCost(row.cost)}
                    </span>
                  </td>
                  <td className="px-3 py-3 first:rounded-l-lg last:rounded-r-lg">
                    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(row.isError)}`}>
                      {row.isError ? "异常" : "成功"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {loadingEmpty ? (
          <div className="mt-4 grid min-h-[55vh] gap-3">
            {[1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : null}

        {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}

        {isEmpty ? <p className="mt-4 text-sm text-slate-400">暂无记录</p> : null}

        {records.length > 0 ? (
          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
            <span>已加载 {records.length} 条</span>
            {loading ? <span>加载中...</span> : hasMore ? <span>继续向下滚动加载</span> : <span>已到底</span>}
          </div>
        ) : null}

        <div ref={sentinelRef} className="h-6" />
      </section>
    </main>
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
    }, 100);
  };

  useEffect(() => {
    if (open) {
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
            e.preventDefault();
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
              className={`flex w-full items-start justify-between px-3 py-2 text-left text-sm transition ${
                darkMode ? "text-slate-200 hover:bg-slate-800" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              <span className="whitespace-normal break-words text-left">{opt}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}