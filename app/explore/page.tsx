"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { formatCompactNumber, formatNumberWithCommas } from "@/lib/utils";

type ExplorePoint = {
  ts: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  model: string;
};

type ExploreResponse = {
  days: number;
  total: number;
  returned: number;
  step: number;
  points: ExplorePoint[];
  error?: string;
};

// 高对比度明亮色卡 - 确保任意相邻颜色都有明显区分
// 精选 12 色，使用更明亮的色调以适应暗色主题，每个颜色唯一
const MODEL_COLORS = [
  "#ff6b6b", // 亮红
  "#4ecdc4", // 青绿
  "#ffe66d", // 亮黄
  "#a29bfe", // 淡紫
  "#55efc4", // 薄荷绿
  "#fd79a8", // 粉红
  "#74b9ff", // 天蓝
  "#ffeaa7", // 奶黄
  "#dfe6e9", // 浅灰蓝
  "#e17055", // 珊瑚橙
  "#00cec9", // 亮青
  "#6c5ce7", // 靛紫
];

const TOKEN_COLORS = {
  input: "#60a5fa",
  output: "#4ade80",
  reasoning: "#fbbf24",
  cached: "#c084fc"
} as const;

const CHART_MARGIN = { top: 8, right: 12, left: 8, bottom: 12 };

function clamp(num: number, min: number, max: number) {
  return Math.min(Math.max(num, min), max);
}

// 添加小范围的 padding 使边缘点完整显示
function niceDomain([min, max]: [number, number], paddingRatio = 0.02): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const range = max - min;
  const padding = range * paddingRatio;
  return [min - padding, max + padding];
}

// Y 轴使用：底部保持 0，顶部添加 padding
function niceYDomain([min, max]: [number, number], paddingRatio = 0.02): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const range = max - min;
  const topPadding = range * paddingRatio;
  return [Math.max(0, min), max + topPadding];
}

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function formatTs(ms: number) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  return timeFormatter.format(d);
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-700/50 ${className ?? ""}`} />;
}

export default function ExplorePage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // 移除 recharts Scatter 的 clip-path 使边缘点完整显示
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const observer = new MutationObserver(() => {
      const scatterLayers = chartContainerRef.current?.querySelectorAll('.recharts-scatter');
      scatterLayers?.forEach(el => {
        if (el.hasAttribute('clip-path')) {
          el.removeAttribute('clip-path');
        }
      });
    });
    observer.observe(chartContainerRef.current, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, []);

  const [rangeDays, setRangeDays] = useState(() => {
    if (typeof window === "undefined") return 14;
    const saved = window.localStorage.getItem("rangeDays");
    const parsed = saved ? Number.parseInt(saved, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : 14;
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ExploreResponse | null>(null);

  const points = useMemo(() => data?.points ?? [], [data]);

  // brush 选择区域状态
  const [brushStart, setBrushStart] = useState<{ x: number; y: number } | null>(null);
  const [brushEnd, setBrushEnd] = useState<{ x: number; y: number } | null>(null);
  const [isBrushing, setIsBrushing] = useState(false);
  
  // 缩放后的视图区域
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null);

  // 图例交互状态
  const [highlightedModel, setHighlightedModel] = useState<string | null>(null);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());

  // 过滤后的点（排除隐藏的模型）
  const filteredPoints = useMemo(() => {
    if (hiddenModels.size === 0) return points;
    return points.filter(p => !hiddenModels.has(p.model));
  }, [points, hiddenModels]);

  const dataBounds = useMemo(() => {
    if (filteredPoints.length === 0) return null;
    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    for (const p of filteredPoints) {
      if (!Number.isFinite(p.ts) || !Number.isFinite(p.tokens)) continue;
      xMin = Math.min(xMin, p.ts);
      xMax = Math.max(xMax, p.ts);
      yMin = Math.min(yMin, p.tokens);
      yMax = Math.max(yMax, p.tokens);
    }
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
    return { x: niceDomain([xMin, xMax]), y: niceYDomain([yMin, yMax]) };
  }, [filteredPoints]);

  // 当前实际使用的 domain（考虑缩放）
  const activeDomain = useMemo(() => {
    if (zoomDomain) return zoomDomain;
    return dataBounds;
  }, [dataBounds, zoomDomain]);

  // 计算 Y 轴分布（token 数量的直方图数据）
  const yDistribution = useMemo(() => {
    if (!activeDomain || filteredPoints.length === 0) return [];
    
    const [yMin, yMax] = activeDomain.y;
    const binCount = 50; // 更多 bin 使曲线更平滑
    const binSize = (yMax - yMin) / binCount;
    const bins = new Array(binCount).fill(0);
    
    for (const p of filteredPoints) {
      if (p.tokens < yMin || p.tokens > yMax) continue;
      const binIndex = Math.min(Math.floor((p.tokens - yMin) / binSize), binCount - 1);
      bins[binIndex]++;
    }
    
    // 返回从上到下排列（Y 轴顶部对应高 token 值）
    return bins.map((count, i) => ({
      y: yMin + (i + 0.5) * binSize,
      count
    })).reverse();
  }, [activeDomain, filteredPoints]);

  // 存储图表区域信息用于坐标转换
  const chartAreaRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  
  // 存储像素级的 brush 位置（用于显示选择框）
  const [brushPixelStart, setBrushPixelStart] = useState<{ x: number; y: number } | null>(null);
  const [brushPixelEnd, setBrushPixelEnd] = useState<{ x: number; y: number } | null>(null);

  // 使用 DOM 事件进行 brush 操作，因为 ScatterChart 的 recharts 事件可能不在空白区域触发
  const handleContainerMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!chartContainerRef.current || !activeDomain) return;
    
    const containerRect = chartContainerRef.current.getBoundingClientRect();
    
    // 尝试找到 SVG 内部的 CartesianGrid 来确定实际的绘图区域
    const gridElement = chartContainerRef.current.querySelector('.recharts-cartesian-grid');
    let area: { x: number; y: number; width: number; height: number };
    
    if (gridElement) {
      const gridRect = gridElement.getBoundingClientRect();
      area = {
        x: gridRect.left - containerRect.left,
        y: gridRect.top - containerRect.top,
        width: gridRect.width,
        height: gridRect.height
      };
    } else {
      // 降级到使用 margin 计算
      area = {
        x: CHART_MARGIN.left,
        y: CHART_MARGIN.top,
        width: containerRect.width - CHART_MARGIN.left - CHART_MARGIN.right,
        height: containerRect.height - CHART_MARGIN.top - CHART_MARGIN.bottom
      };
    }
    chartAreaRef.current = area;
    
    // 计算相对于容器的坐标
    const mouseX = e.clientX - containerRect.left;
    const mouseY = e.clientY - containerRect.top;
    
    // 检查是否在图表区域内
    if (mouseX < area.x || mouseX > area.x + area.width || mouseY < area.y || mouseY > area.y + area.height) {
      return;
    }
    
    // 存储像素坐标
    setBrushPixelStart({ x: mouseX, y: mouseY });
    setBrushPixelEnd({ x: mouseX, y: mouseY });
    
    // 转换为数据坐标
    const xRatio = clamp((mouseX - area.x) / area.width, 0, 1);
    const yRatio = clamp(1 - (mouseY - area.y) / area.height, 0, 1);
    
    const xValue = activeDomain.x[0] + xRatio * (activeDomain.x[1] - activeDomain.x[0]);
    const yValue = activeDomain.y[0] + yRatio * (activeDomain.y[1] - activeDomain.y[0]);
    
    setBrushStart({ x: xValue, y: yValue });
    setBrushEnd({ x: xValue, y: yValue });
    setIsBrushing(true);
  }, [activeDomain]);

  const handleContainerMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isBrushing || !chartContainerRef.current || !activeDomain || !chartAreaRef.current) return;
    
    const rect = chartContainerRef.current.getBoundingClientRect();
    const area = chartAreaRef.current;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // 更新像素坐标
    setBrushPixelEnd({ x: mouseX, y: mouseY });
    
    const xRatio = clamp((mouseX - area.x) / area.width, 0, 1);
    const yRatio = clamp(1 - (mouseY - area.y) / area.height, 0, 1);
    
    const xValue = activeDomain.x[0] + xRatio * (activeDomain.x[1] - activeDomain.x[0]);
    const yValue = activeDomain.y[0] + yRatio * (activeDomain.y[1] - activeDomain.y[0]);
    
    setBrushEnd({ x: xValue, y: yValue });
  }, [isBrushing, activeDomain]);

  const handleContainerMouseUp = useCallback(() => {
    if (!isBrushing || !brushStart || !brushEnd) {
      setIsBrushing(false);
      setBrushStart(null);
      setBrushEnd(null);
      setBrushPixelStart(null);
      setBrushPixelEnd(null);
      return;
    }

    const xMin = Math.min(brushStart.x, brushEnd.x);
    const xMax = Math.max(brushStart.x, brushEnd.x);
    const yMin = Math.min(brushStart.y, brushEnd.y);
    const yMax = Math.max(brushStart.y, brushEnd.y);

    // 需要有一定的选择范围才触发缩放（基于当前视图范围的 2%）
    const currentDomain = activeDomain ?? dataBounds;
    const xRange = currentDomain ? currentDomain.x[1] - currentDomain.x[0] : 1;
    const yRange = currentDomain ? currentDomain.y[1] - currentDomain.y[0] : 1;
    
    if ((xMax - xMin) > xRange * 0.02 && (yMax - yMin) > yRange * 0.02) {
      setZoomDomain({ x: [xMin, xMax], y: [yMin, yMax] });
    }

    setIsBrushing(false);
    setBrushStart(null);
    setBrushEnd(null);
    setBrushPixelStart(null);
    setBrushPixelEnd(null);
  }, [isBrushing, brushStart, brushEnd, activeDomain, dataBounds]);

  // 重置缩放
  const resetZoom = useCallback(() => {
    setZoomDomain(null);
  }, []);

  // 当数据变化时重置缩放
  useEffect(() => {
    setZoomDomain(null);
  }, [points]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "rangeDays") return;
      const parsed = e.newValue ? Number.parseInt(e.newValue, 10) : NaN;
      if (Number.isFinite(parsed)) setRangeDays(parsed);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("days", String(rangeDays));

        const res = await fetch(`/api/explore?${params.toString()}`, { cache: "no-store" });
        const json: ExploreResponse = await res.json();

        if (!res.ok) {
          throw new Error(json?.error || res.statusText);
        }

        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message || "加载失败");
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [rangeDays]);

  const models = useMemo(() => {
    const set = new Set<string>();
    for (const p of points) {
      if (p.model) set.add(p.model);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [points]);

  // 基于模型在列表中的索引分配颜色，避免哈希碰撞
  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    models.forEach((m, idx) => {
      map.set(m, MODEL_COLORS[idx % MODEL_COLORS.length]);
    });
    return map;
  }, [models]);

  const getModelColor = useCallback((model: string) => {
    return modelColorMap.get(model) ?? MODEL_COLORS[0];
  }, [modelColorMap]);

  const dotShape = useMemo(() => {
    return function Dot(props: any) {
      const { cx, cy, payload } = props;
      if (cx == null || cy == null) return <g />;
      const model = String(payload?.model ?? "");
      const fill = modelColorMap.get(model) ?? MODEL_COLORS[0];
      const isHighlighted = highlightedModel === model;
      
      // 缩放后点变大
      const baseRadius = zoomDomain ? 5 : 3;
      const radius = isHighlighted ? baseRadius + 2 : baseRadius;
      
      return (
        <circle 
          cx={cx} 
          cy={cy} 
          r={radius} 
          fill={fill} 
          fillOpacity={highlightedModel && !isHighlighted ? 0.15 : 0.6}
          stroke={isHighlighted ? "#fff" : "none"}
          strokeWidth={isHighlighted ? 1 : 0}
        />
      );
    };
  }, [modelColorMap, highlightedModel, zoomDomain]);

  // 图例交互处理
  const handleLegendMouseEnter = useCallback((model: string) => {
    setHighlightedModel(model);
  }, []);

  const handleLegendMouseLeave = useCallback(() => {
    setHighlightedModel(null);
  }, []);

  const handleLegendClick = useCallback((model: string) => {
    setHiddenModels(prev => {
      const next = new Set(prev);
      if (next.has(model)) {
        next.delete(model);
      } else {
        next.add(model);
      }
      return next;
    });
  }, []);

  return (
    <main className="min-h-screen bg-slate-900 px-6 py-8 text-slate-100">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">数据探索</h1>
          <p className="text-sm text-slate-400">每个点代表一次请求（X=时间，Y=token 数，颜色=模型）</p>
        </div>
        <div className="text-sm text-slate-300">
          <span className="text-slate-400">时间范围：</span>
          <span>{`最近 ${rangeDays} 天（与仪表盘同步）`}</span>
          {data?.step && data.step > 1 ? (
            <span className="ml-3 text-slate-400">{`已抽样：每 ${data.step} 个点取 1 个`}</span>
          ) : null}
        </div>
      </header>

      <section className="mt-6 rounded-2xl bg-slate-950/40 p-5 ring-1 ring-slate-800">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300">
          <div>
            <span className="text-slate-400">总点数：</span>
            <span>{formatNumberWithCommas(data?.total ?? 0)}</span>
          </div>
          <div>
            <span className="text-slate-400">渲染点数：</span>
            <span>{formatNumberWithCommas(data?.returned ?? 0)}</span>
          </div>
          {zoomDomain && (
            <button
              type="button"
              onClick={resetZoom}
              className="rounded-lg bg-slate-700 px-3 py-1 text-xs text-slate-200 transition-colors hover:bg-slate-600"
            >
              重置缩放
            </button>
          )}
          <span className="ml-auto text-xs text-slate-500">提示：拖拽框选可缩放区域</span>
        </div>

        {models.length > 0 ? (
          <div className="mt-3 rounded-xl bg-slate-900/30 p-3 ring-1 ring-slate-800">
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
              <span className="text-slate-400">颜色区分模型（悬停高亮，点击隐藏）</span>
            </div>
            <div className="mt-2 max-h-20 overflow-auto pr-1">
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300">
                {models.map((m) => {
                  const isHidden = hiddenModels.has(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      className={`flex items-center gap-2 rounded-md px-1.5 py-0.5 transition-all hover:bg-slate-700/50 ${isHidden ? 'opacity-40' : ''}`}
                      onMouseEnter={() => handleLegendMouseEnter(m)}
                      onMouseLeave={handleLegendMouseLeave}
                      onClick={() => handleLegendClick(m)}
                    >
                      <span 
                        className={`h-2.5 w-2.5 rounded-full ${isHidden ? 'ring-1 ring-slate-500' : ''}`} 
                        style={{ backgroundColor: isHidden ? 'transparent' : getModelColor(m), opacity: isHidden ? 1 : 0.7 }} 
                      />
                      <span className={`max-w-[18rem] truncate ${isHidden ? 'line-through' : ''}`}>{m}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-4 h-[70vh]">
          {loading ? (
            <Skeleton className="h-full" />
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 text-center">
              <p className="text-base text-slate-300">加载失败</p>
              <p className="mt-1 text-sm text-slate-500">{error}</p>
            </div>
          ) : points.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 text-center">
              <p className="text-base text-slate-300">暂无请求明细数据</p>
              <p className="mt-1 text-sm text-slate-500">如果上游 /usage 未提供 details，此图会为空。</p>
            </div>
          ) : (
            <div className="relative flex h-full gap-0">
              {/* Y 轴分布面积图（竖向，波峰朝左）- 使用绝对定位精确对齐 */}
              <div 
                className="absolute left-0 w-16"
                style={{ 
                  top: CHART_MARGIN.top - 2, 
                  height: `calc(94.5% - ${CHART_MARGIN.top}px - ${CHART_MARGIN.bottom}px)` 
                }}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart 
                    data={yDistribution} 
                    layout="vertical"
                    margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="yDistGradient" x1="1" y1="0" x2="0" y2="0">
                        <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.08} />
                        <stop offset="40%" stopColor="#60a5fa" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.5} />
                      </linearGradient>
                    </defs>
                    <XAxis type="number" hide domain={[0, 'dataMax']} reversed />
                    <YAxis type="category" dataKey="y" hide />
                    <Area 
                      type="basis" 
                      dataKey="count" 
                      stroke="#60a5fa" 
                      strokeWidth={1.5}
                      strokeOpacity={0.6}
                      fill="url(#yDistGradient)" 
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              
              {/* 主散点图 - 左侧留出面积图的空间 */}
              <div 
                ref={chartContainerRef} 
                className="relative flex-1 select-none"
                style={{ marginLeft: 64 }}
                onMouseDown={handleContainerMouseDown}
                onMouseMove={handleContainerMouseMove}
                onMouseUp={handleContainerMouseUp}
                onMouseLeave={handleContainerMouseUp}
                onDoubleClick={zoomDomain ? resetZoom : undefined}
              >
                {/* Brush 选择区域可视化 - 使用绝对定位的 div */}
                {isBrushing && brushPixelStart && brushPixelEnd && (
                  <div
                    className="pointer-events-none absolute border border-blue-400/80 bg-blue-400/15"
                    style={{
                      left: Math.min(brushPixelStart.x, brushPixelEnd.x),
                      top: Math.min(brushPixelStart.y, brushPixelEnd.y),
                      width: Math.abs(brushPixelEnd.x - brushPixelStart.x),
                    height: Math.abs(brushPixelEnd.y - brushPixelStart.y),
                  }}
                />
              )}
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart 
                  margin={CHART_MARGIN}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis
                    type="number"
                    dataKey="ts"
                    domain={activeDomain?.x}
                    scale="time"
                    tickFormatter={(v) => formatTs(Number(v))}
                    stroke="#94a3b8"
                    fontSize={12}
                    allowDataOverflow
                  />
                  <YAxis
                    type="number"
                    dataKey="tokens"
                    domain={activeDomain?.y}
                    stroke="#94a3b8"
                    fontSize={12}
                    tickFormatter={(v) => formatCompactNumber(Number(v))}
                    allowDataOverflow
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(148,163,184,0.25)", strokeWidth: 1 }}
                    isAnimationActive={false}
                    wrapperStyle={{ zIndex: 100, pointerEvents: "none" }}
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload[0]?.payload) return null;
                      const p = payload[0].payload as ExplorePoint;
                      const modelColor = getModelColor(p.model || "");
                      return (
                        <div className="rounded-xl bg-black/50 px-3 py-2 text-sm shadow-lg ring-1 ring-slate-700/60">
                          <div className="font-semibold text-slate-100">{formatTs(p.ts)}</div>
                          <div className="mt-1 flex items-center gap-2 text-slate-200">
                            <span className="text-slate-400">模型：</span>
                            <span className="inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: modelColor, opacity: 0.7 }} />
                            <span className="max-w-[22rem] truncate">{p.model || "-"}</span>
                          </div>

                          <div className="mt-1 text-slate-200">
                            <span className="text-slate-400">总 Tokens：</span>
                            <span>{formatNumberWithCommas(p.tokens)}</span>
                          </div>

                          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-slate-200">
                            <div>
                              <span className="text-slate-400">输入：</span>
                              <span style={{ color: TOKEN_COLORS.input }}>{formatNumberWithCommas(p.inputTokens)}</span>
                            </div>
                            <div>
                              <span className="text-slate-400">输出：</span>
                              <span style={{ color: TOKEN_COLORS.output }}>{formatNumberWithCommas(p.outputTokens)}</span>
                            </div>
                            <div>
                              <span className="text-slate-400">思考：</span>
                              <span style={{ color: TOKEN_COLORS.reasoning }}>{formatNumberWithCommas(p.reasoningTokens)}</span>
                            </div>
                            <div>
                              <span className="text-slate-400">缓存：</span>
                              <span style={{ color: TOKEN_COLORS.cached }}>{formatNumberWithCommas(p.cachedTokens)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Scatter data={filteredPoints} shape={dotShape} isAnimationActive={false} />
                </ScatterChart>
              </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
