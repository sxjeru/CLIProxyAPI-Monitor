"use client";

import { forwardRef, startTransition, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
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

// 高对比度明亮色卡 - 20 色高饱和高明度，确保各色间强区分
// 按色相分布均匀，饱和度 70-90%，明度 55-75%，适配暗色主题
// 排序优化：按 1,3,5,7,9,2,4,6,8,10 交叉排列，最大化相邻颜色差异
const MODEL_COLORS = [
  "#ff7a7aff", // 14 玫红 (345°)
  "#ffe863ff", // 3 橙黄 (40°)
  "#8df48dff", // 6 绿 (120°)
  "#72afffff", // 9 蓝 (220°)
  "#a582ff", // 11 紫 (270°)
  "#99e6ff", // 19 浅蓝 (200°+)
  "#ff76d1ff", // 13 品红 (320°)
  "#ffb3b3", // 15 浅红 (0°+)
  "#fff899", // 17 浅黄 (60°+)
  "#ff8c42", // 2 橙红 (20°)
  "#ffe66d", // 4 黄 (60°)
  "#42c9f5", // 8 天青 (195°)
  "#7d7aff", // 10 靛蓝 (245°)
  "#d97aff", // 12 品红紫 (290°)
  "#ffd699", // 16 浅橙 (40°+)
  "#b3f5b3", // 18 浅绿 (120°+)
  "#d9b3ff", // 20 浅紫 (280°+)
];

const TOKEN_COLORS = {
  input: "#60a5fa",
  output: "#4ade80",
  reasoning: "#fbbf24",
  cached: "#c084fc"
} as const;

const CHART_MARGIN = { top: 8, right: 12, left: 8, bottom: 12 };
const CHART_TOP_INSET = 4;

function clamp(num: number, min: number, max: number) {
  return Math.min(Math.max(num, min), max);
}

// 添加小范围的 padding 使边缘点完整显示
function niceDomain([min, max]: [number, number], paddingRatio = 0.01): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const range = max - min;
  const padding = range * paddingRatio;
  return [min - padding, max + padding];
}

// Y 轴使用：底部添加 -1% padding，顶部添加 2% padding
function niceYDomain([min, max]: [number, number], paddingRatio = 0.02): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [0, max + 1];
  const range = max - min;
  const topPadding = range * paddingRatio;
  const bottomPadding = range * 0.01; // 底部 -1%
  return [min - bottomPadding, max + topPadding];
}

// 固定刻度，避免 lerp 动画导致网格每帧重算
// 仅生成在实际域范围内的刻度值，并在顶部显示实际最大值
function computeNiceTicks([min, max]: [number, number], maxTickCount = 6): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || maxTickCount <= 0) return [];
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.1);
    return [min - pad, min, min + pad];
  }
  const range = max - min;
  const roughStep = range / Math.max(1, maxTickCount - 1);
  const power = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const candidates = [1, 2, 5, 10];
  let step = roughStep;
  for (const c of candidates) {
    const s = c * power;
    if (s >= roughStep) {
      step = s;
      break;
    }
  }
  const tickStart = Math.ceil(min / step) * step;
  const tickEnd = Math.floor(max / step) * step;
  const ticks: number[] = [];
  for (let v = tickStart; v <= tickEnd + step * 0.01 && ticks.length < 200; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  // 如果最后一个刻度距离最大值有明显距离，添加实际最大值作为顶部刻度
  const lastTick = ticks[ticks.length - 1] ?? min;
  const gapToMax = max - lastTick;
  // 当距离超过 step 的 15% 时，添加最大值刻度
  if (gapToMax > step * 0.15) {
    ticks.push(Number(max.toFixed(6)));
  }
  return ticks;
}

// 时间轴刻度计算：确保始终包含起始和结束时间
function computeTimeTicks([min, max]: [number, number], maxTickCount = 8): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || maxTickCount <= 0) return [];
  if (min === max) return [min];
  
  const range = max - min;
  const roughStep = range / Math.max(1, maxTickCount - 1);
  
  // 时间步长候选值（毫秒）
  const timeSteps = [
    1000,           // 1秒
    2000,           // 2秒
    5000,           // 5秒
    10000,          // 10秒
    30000,          // 30秒
    60000,          // 1分钟
    120000,         // 2分钟
    300000,         // 5分钟
    600000,         // 10分钟
    900000,         // 15分钟
    1800000,        // 30分钟
    3600000,        // 1小时
    7200000,        // 2小时
    10800000,       // 3小时
    21600000,       // 6小时
    43200000,       // 12小时
    86400000,       // 1天
    172800000,      // 2天
    432000000,      // 5天
    604800000,      // 7天
  ];
  
  // 选择合适的步长
  let step = timeSteps[timeSteps.length - 1];
  for (const s of timeSteps) {
    if (s >= roughStep) {
      step = s;
      break;
    }
  }
  
  // 生成中间刻度
  const ticks: number[] = [min]; // 始终包含起始时间
  const tickStart = Math.ceil(min / step) * step;
  const tickEnd = Math.floor(max / step) * step;
  
  for (let v = tickStart; v <= tickEnd && ticks.length < 200; v += step) {
    // 避免与起始时间太接近（小于5%的范围）
    if (Math.abs(v - min) > range * 0.05 && Math.abs(v - max) > range * 0.05) {
      ticks.push(Number(v.toFixed(0)));
    }
  }
  
  // 始终包含结束时间
  ticks.push(max);
  
  return ticks;
}

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDateInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTs(ms: number) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  return timeFormatter.format(d);
}

function useLerpYDomain(
  targetDomain: [number, number] | undefined,
  factor = 0.15,
  enabled = true
): [number, number] | undefined {
  const [currentDomain, setCurrentDomain] = useState(targetDomain);
  const targetRef = useRef(targetDomain);
  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const frameRef = useRef(0);

  // Sync domain when target changes or animation is disabled
  useEffect(() => {
    if (!targetDomain || !enabled) {
      startTransition(() => setCurrentDomain(targetDomain));
    }
  }, [targetDomain, enabled]);

  useEffect(() => {
    targetRef.current = targetDomain;
  }, [targetDomain]);

  useEffect(() => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
    }

    // Only proceed with animation if target exists and enabled
    if (!targetDomain || !enabled) {
      return;
    }

    // 单一路径：提高帧数保证平滑，同时限定总时长避免拖沓
    const stepFactor = factor;
    const maxFrames = 60;
    const maxDuration = 1000; // ms
    const snapThreshold = 1; // token 差值小于阈值直接吸附

    startTimeRef.current = null;
    frameRef.current = 0;

    const animate = (timestamp: number) => {
      if (startTimeRef.current == null) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      let shouldContinue = true;

      setCurrentDomain(prev => {
        const target = targetRef.current;
        if (!target) {
          shouldContinue = false;
          return undefined;
        }
        if (!prev) {
          shouldContinue = false;
          return target;
        }

        const [currentMin, currentMax] = prev;
        const [targetMin, targetMax] = target;

        const diffMin = targetMin - currentMin;
        const diffMax = targetMax - currentMax;

        const snapMin = Math.abs(diffMin) <= snapThreshold;
        const snapMax = Math.abs(diffMax) <= snapThreshold;

        if (snapMin && snapMax) {
          shouldContinue = false;
          return target;
        }

        return [
          currentMin + diffMin * stepFactor,
          currentMax + diffMax * stepFactor
        ];
      });

      frameRef.current += 1;

      if (!shouldContinue || frameRef.current >= maxFrames || elapsed >= maxDuration) {
        setCurrentDomain(targetRef.current);
        return;
      }

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [enabled, factor, targetDomain]);

  return currentDomain;
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-700/50 ${className ?? ""}`} />;
}

// 独立的图例组件，使用 React.memo 避免不必要的重渲染
import { memo } from "react";

type ModelLegendProps = {
  models: string[];
  hiddenModels: Set<string>;
  getModelColor: (model: string) => string;
  onMouseEnter: (model: string) => void;
  onMouseLeave: () => void;
  onClick: (model: string) => void;
};

const ModelLegend = memo(function ModelLegend({
  models,
  hiddenModels,
  getModelColor,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: ModelLegendProps) {
  if (models.length === 0) return null;
  
  return (
    <div className="mt-3 rounded-xl bg-slate-900/30 p-3 ring-1 ring-slate-800">
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
        <span className="text-slate-400">模型图例（悬停高亮，点击隐藏）</span>
      </div>
      <div className="mt-2 max-h-20 overflow-auto pr-1">
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-300">
          {models.map((m) => {
            const isHidden = hiddenModels.has(m);
            return (
              <button
                key={m}
                type="button"
                className={`flex items-center gap-2 rounded-md px-1.5 py-0.5 transition-all hover:bg-slate-600/40 ${isHidden ? 'opacity-40' : ''}`}
                onMouseEnter={() => onMouseEnter(m)}
                onMouseLeave={onMouseLeave}
                onClick={() => onClick(m)}
              >
                <span 
                  className={`h-2.5 w-2.5 rounded-full ${isHidden ? 'ring-1 ring-slate-500' : ''}`} 
                  style={{ backgroundColor: isHidden ? 'transparent' : getModelColor(m), opacity: isHidden ? 1 : 0.8 }} 
                />
                <span className={`max-w-[18rem] truncate ${isHidden ? 'line-through' : ''}`}>{m}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default function ExplorePage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // 移除 recharts Scatter 的 clip-path 使边缘点完整显示
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const sanitize = () => {
      const scatterLayers = chartContainerRef.current?.querySelectorAll('.recharts-scatter');
      scatterLayers?.forEach(el => {
        if (el.hasAttribute('clip-path')) {
          el.removeAttribute('clip-path');
        }
      });

      const wrappers = chartContainerRef.current?.querySelectorAll('.recharts-wrapper');
      wrappers?.forEach(el => {
        const wrapperEl = el as HTMLElement;
        wrapperEl.style.outline = 'none';
        wrapperEl.tabIndex = -1;
      });
    };

    const observer = new MutationObserver(sanitize);
    sanitize();
    observer.observe(chartContainerRef.current, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, []);

  type RangeMode = "preset" | "custom";
  type RangeSelection = { mode: RangeMode; days: number; start: string; end: string };

  const [rangeInit] = useState(() => {
    const now = new Date();
    const defaultEnd = now;
    const defaultStart = new Date(now.getTime() - 6 * DAY_MS);
    const fallback: RangeSelection & { source: "global" | "local" } = {
      mode: "preset",
      days: 14,
      start: formatDateInputValue(defaultStart),
      end: formatDateInputValue(defaultEnd),
      source: "global"
    };

    if (typeof window === "undefined") return fallback;

    const parseSelection = (raw: string | null): RangeSelection | null => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<RangeSelection>;
        if (!parsed) return null;
        const mode = parsed.mode === "custom" ? "custom" : "preset";
        const days = Number.isFinite(parsed.days) ? Math.max(1, Number(parsed.days)) : fallback.days;
        const start = parsed.start || fallback.start;
        const end = parsed.end || fallback.end;
        return { mode, days, start, end };
      } catch (err) {
        console.warn("Failed to parse range selection", err);
        return null;
      }
    };

    const globalSel = parseSelection(window.localStorage.getItem("rangeSelection"));
    const localSel = parseSelection(window.localStorage.getItem("rangeSelectionExplore"));

    if (globalSel) return { ...globalSel, source: "global" } as const;
    if (localSel) return { ...localSel, source: "local" } as const;
    return fallback;
  });

  const [rangeMode, setRangeMode] = useState<RangeMode>(rangeInit.mode);
  const [rangeDays, setRangeDays] = useState(rangeInit.days);
  const [customStart, setCustomStart] = useState(rangeInit.start);
  const [customEnd, setCustomEnd] = useState(rangeInit.end);
  const [appliedDays, setAppliedDays] = useState(rangeInit.days);
  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  const [customDraftStart, setCustomDraftStart] = useState(rangeInit.start);
  const [customDraftEnd, setCustomDraftEnd] = useState(rangeInit.end);
  const [customError, setCustomError] = useState<string | null>(null);
  const [selectionSource, setSelectionSource] = useState<"global" | "local">(rangeInit.source);
  const [globalSelection, setGlobalSelection] = useState<RangeSelection>({ mode: rangeInit.mode, days: rangeInit.days, start: rangeInit.start, end: rangeInit.end });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ExploreResponse | null>(null);
  
  // 堆叠面积图开关
  const [showStackedArea, setShowStackedArea] = useState(true);
  
  const scatterTooltipRef = useRef<ScatterTooltipHandle>(null);

  // 持久化本页自定义选择，不回写仪表盘
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectionSource !== "local") return;
    const payload: RangeSelection = { mode: rangeMode, days: rangeDays, start: customStart, end: customEnd };
    window.localStorage.setItem("rangeSelectionExplore", JSON.stringify(payload));
  }, [selectionSource, rangeMode, rangeDays, customStart, customEnd]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("rangeSelection");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<RangeSelection>;
      if (!parsed) return;
      const next: RangeSelection = {
        mode: parsed.mode === "custom" ? "custom" : "preset",
        days: Number.isFinite(parsed.days) ? Math.max(1, Number(parsed.days)) : rangeDays,
        start: parsed.start || customStart,
        end: parsed.end || customEnd
      };
      setGlobalSelection(next);
      if (selectionSource === "global") {
        setRangeMode(next.mode);
        setRangeDays(next.days);
        setCustomStart(next.start);
        setCustomEnd(next.end);
        setAppliedDays(next.days);
      }
    } catch (err) {
      console.warn("Failed to load global rangeSelection", err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  type ScatterTooltipHandle = {
    show: (point: ExplorePoint, x: number, y: number) => void;
    hide: () => void;
  };

  const ScatterTooltip = forwardRef<ScatterTooltipHandle, { getModelColor: (model: string) => string }>(
    ({ getModelColor }, ref) => {
      const [state, setState] = useState<{ point: ExplorePoint; x: number; y: number } | null>(null);
      const tooltipRef = useRef<HTMLDivElement>(null);

      useImperativeHandle(ref, () => ({
        show: (point, x, y) => setState({ point, x, y }),
        hide: () => setState(null)
      }), []);

      if (!state) return null;

      // 计算 tooltip 位置，避免超出屏幕右边缘
      const tooltipWidth = tooltipRef.current?.offsetWidth ?? 300; // 默认估算宽度
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920;
      
      // 默认显示在鼠标右侧
      const defaultLeft = state.x + 12;
      
      // 检查是否会超出右边缘（留 20px 余量）
      const wouldOverflow = defaultLeft + tooltipWidth > viewportWidth - 20;
      
      // 根据是否溢出选择定位方式
      const positionStyle = wouldOverflow
        ? { right: viewportWidth - state.x + 12 } // 使用 right 定位，显示在鼠标左侧
        : { left: defaultLeft }; // 使用 left 定位，显示在鼠标右侧

      return (
        <div 
          ref={tooltipRef}
          className="pointer-events-none fixed z-50 rounded-xl bg-slate-900/60 px-3 py-2 text-sm shadow-lg ring-1 ring-slate-600/60 backdrop-blur-sm"
          style={{ 
            ...positionStyle,
            top: state.y - 10,
            transform: 'translateY(-100%)'
          }}
        >
          <div className="font-semibold text-slate-100">{formatTs(state.point.ts)}</div>
          <div className="mt-1 flex items-center gap-2 text-slate-200">
            <span className="text-slate-400">模型：</span>
            <span className="inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getModelColor(state.point.model || ""), opacity: 0.7 }} />
            <span className="max-w-[22rem] truncate">{state.point.model || "-"}</span>
          </div>
          <div className="mt-1 text-slate-200">
            <span className="text-slate-400">总 Tokens：</span>
            <span>{formatNumberWithCommas(state.point.tokens)}</span>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-slate-200">
            <div>
              <span className="text-slate-400">输入：</span>
              <span style={{ color: TOKEN_COLORS.input }}>{formatNumberWithCommas(state.point.inputTokens)}</span>
            </div>
            <div>
              <span className="text-slate-400">输出：</span>
              <span style={{ color: TOKEN_COLORS.output }}>{formatNumberWithCommas(state.point.outputTokens)}</span>
            </div>
            <div>
              <span className="text-slate-400">思考：</span>
              <span style={{ color: TOKEN_COLORS.reasoning }}>{formatNumberWithCommas(state.point.reasoningTokens)}</span>
            </div>
            <div>
              <span className="text-slate-400">缓存：</span>
              <span style={{ color: TOKEN_COLORS.cached }}>{formatNumberWithCommas(state.point.cachedTokens)}</span>
            </div>
          </div>
        </div>
      );
    }
  );
  ScatterTooltip.displayName = "ScatterTooltip";

  const points = useMemo(() => data?.points ?? [], [data]);

  // brush 选择区域状态
  const brushStartRef = useRef<{ x: number; y: number } | null>(null);
  const brushEndRef = useRef<{ x: number; y: number } | null>(null);
  const [isBrushing, setIsBrushing] = useState(false);
  
  // 缩放后的视图区域
  const [zoomDomain, setZoomDomain] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  // 缩放来源：'brush' = 主图框选, 'range' = 底部范围选择器
  const [zoomSource, setZoomSource] = useState<'brush' | 'range' | null>(null);

  // X 轴范围选择器状态（简化：只支持拖动边界）
  const [isXRangeDragging, setIsXRangeDragging] = useState(false);
  const [xRangeDragType, setXRangeDragType] = useState<'left' | 'right' | 'move' | null>(null);
  const [xRangeDragStartX, setXRangeDragStartX] = useState<number | null>(null);
  const [xRangeOriginalDomain, setXRangeOriginalDomain] = useState<[number, number] | null>(null);
  const xRangeContainerRef = useRef<HTMLDivElement>(null);
  // 范围选择器 hover 状态（用于显示时间标签）
  const [xRangeHover, setXRangeHover] = useState<'left' | 'right' | 'box' | null>(null);
  // rAF 合并 X 轴范围拖动，减少频繁 setState
  const xRangeUpdateFrameRef = useRef<number | null>(null);
  const pendingXRangeRef = useRef<[number, number] | null>(null);

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

  const flushXRangeUpdate = useCallback(() => {
    const pending = pendingXRangeRef.current;
    xRangeUpdateFrameRef.current = null;
    if (!pending) return;
    setZoomDomain(prev => prev
      ? { ...prev, x: pending }
      : { x: pending, y: dataBounds?.y ?? [0, 1] }
    );
    setZoomSource('range');
    pendingXRangeRef.current = null;
  }, [dataBounds]);

  const scheduleXRangeUpdate = useCallback((next: [number, number]) => {
    pendingXRangeRef.current = next;
    if (xRangeUpdateFrameRef.current == null) {
      xRangeUpdateFrameRef.current = requestAnimationFrame(flushXRangeUpdate);
    }
  }, [flushXRangeUpdate]);

  // 当前实际使用的 domain（考虑缩放）
  const activeDomain = useMemo<{ x: [number, number]; y: [number, number] } | null>(() => {
    if (!dataBounds) return null;
    if (!zoomDomain) return dataBounds;

    // 如果是主图框选，直接使用框选的范围
    if (zoomSource === 'brush') {
      return zoomDomain;
    }

    // 如果是底部范围选择器，X 轴使用选择的范围，Y 轴根据当前时间范围内的点自动计算
    if (zoomSource === 'range') {
      const [xMin, xMax] = zoomDomain.x;
      let yMax = Number.NEGATIVE_INFINITY;
      let hasPoints = false;

      for (const p of filteredPoints) {
        if (p.ts >= xMin && p.ts <= xMax) {
          yMax = Math.max(yMax, p.tokens);
          hasPoints = true;
        }
      }

      if (!hasPoints) {
        return { x: zoomDomain.x, y: dataBounds.y };
      }

      // 保持 Y 轴底部不动（使用全局 padding 后的下界），仅顶部随可视范围自适应
      const fixedBottom = dataBounds.y[0];
      const [, paddedTop] = niceYDomain([fixedBottom, yMax]);
      return { x: zoomDomain.x, y: [fixedBottom, paddedTop] as [number, number] };
    }

    return zoomDomain;
  }, [dataBounds, zoomDomain, zoomSource, filteredPoints]);

  // 仅渲染可视范围内的散点，并将数量用于动画降级
  const visiblePoints = useMemo(() => {
    if (!activeDomain) return filteredPoints;
    const [xMin, xMax] = activeDomain.x;
    const [yMin, yMax] = activeDomain.y;
    return filteredPoints.filter(p => 
      p.ts >= xMin && p.ts <= xMax && p.tokens >= yMin && p.tokens <= yMax
    );
  }, [filteredPoints, activeDomain]);

  // 使用平滑过渡的 Y 轴 domain (Lerp 动画)
  // 框选缩放时禁用动画，只有范围选择器缩放时才启用平滑过渡
  const enableLerpAnimation = zoomSource === 'range';
  const smoothYDomain = useLerpYDomain(activeDomain?.y, 0.15, enableLerpAnimation);

  // 基于当前渲染的 domain 计算刻度，确保刻度与显示值匹配
  const computedYTicks = useMemo(() => {
    const domain = smoothYDomain || activeDomain?.y;
    if (!domain) return undefined;
    return computeNiceTicks(domain);
  }, [smoothYDomain, activeDomain?.y]);

  // 计算 X 轴时间刻度，确保边界刻度正确显示
  const computedXTicks = useMemo(() => {
    if (!activeDomain?.x) return undefined;
    return computeTimeTicks(activeDomain.x);
  }, [activeDomain?.x]);

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

  // 计算 X 轴分布（时间分布的面积图数据，用于范围选择器）
  const xDistribution = useMemo(() => {
    if (!dataBounds || filteredPoints.length === 0) return [];
    
    const [xMin, xMax] = dataBounds.x;
    const binCount = 100; // 更多 bin 使曲线更平滑
    const binSize = (xMax - xMin) / binCount;
    const bins = new Array(binCount).fill(0);
    
    for (const p of filteredPoints) {
      if (p.ts < xMin || p.ts > xMax) continue;
      const binIndex = Math.min(Math.floor((p.ts - xMin) / binSize), binCount - 1);
      bins[binIndex] += p.tokens; // 累加 tokens 而不是计数
    }
    
    return bins.map((totalTokens, i) => ({
      ts: xMin + (i + 0.5) * binSize,
      tokens: totalTokens
    }));
  }, [dataBounds, filteredPoints]);

  // 存储图表区域信息用于坐标转换
  const chartAreaRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  
  // 存储像素级的 brush 位置（用于显示选择框）
  const brushPixelStartRef = useRef<{ x: number; y: number } | null>(null);
  const brushPixelEndRef = useRef<{ x: number; y: number } | null>(null);
  const brushOverlayRef = useRef<HTMLDivElement>(null);

  // 使用 rAF 合并高频鼠标事件，避免过多状态更新导致掉帧
  const brushMoveFrameRef = useRef<number | null>(null);
  const pendingBrushUpdateRef = useRef<{
    pixel: { x: number; y: number };
    data: { x: number; y: number };
  } | null>(null);

  const applyBrushOverlay = useCallback(() => {
    if (!brushOverlayRef.current || !brushPixelStartRef.current || !brushPixelEndRef.current) return;
    const start = brushPixelStartRef.current;
    const end = brushPixelEndRef.current;
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    const el = brushOverlayRef.current;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  }, []);

  // 使用 DOM 事件进行 brush 操作，因为 ScatterChart 的 recharts 事件可能不在空白区域触发
  const handleContainerMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
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
    brushPixelStartRef.current = { x: mouseX, y: mouseY };
    brushPixelEndRef.current = { x: mouseX, y: mouseY };
    brushOverlayRef.current && (brushOverlayRef.current.style.display = 'block');
    applyBrushOverlay();
    
    // 转换为数据坐标
    const xRatio = clamp((mouseX - area.x) / area.width, 0, 1);
    const yRatio = clamp(1 - (mouseY - area.y) / area.height, 0, 1);
    
    const xValue = activeDomain.x[0] + xRatio * (activeDomain.x[1] - activeDomain.x[0]);
    const yValue = activeDomain.y[0] + yRatio * (activeDomain.y[1] - activeDomain.y[0]);
    
    brushStartRef.current = { x: xValue, y: yValue };
    brushEndRef.current = { x: xValue, y: yValue };
    setIsBrushing(true);
  }, [activeDomain, applyBrushOverlay]);

  // rAF 驱动的鼠标移动处理，减少 React 渲染频率
  const handleContainerMouseMoveWithRaf = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isBrushing || !chartContainerRef.current || !activeDomain || !chartAreaRef.current) return;
    const rect = chartContainerRef.current.getBoundingClientRect();
    const area = chartAreaRef.current;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const xRatio = clamp((mouseX - area.x) / area.width, 0, 1);
    const yRatio = clamp(1 - (mouseY - area.y) / area.height, 0, 1);

    const xValue = activeDomain.x[0] + xRatio * (activeDomain.x[1] - activeDomain.x[0]);
    const yValue = activeDomain.y[0] + yRatio * (activeDomain.y[1] - activeDomain.y[0]);

    pendingBrushUpdateRef.current = {
      pixel: { x: mouseX, y: mouseY },
      data: { x: xValue, y: yValue }
    };

    if (brushMoveFrameRef.current == null) {
      brushMoveFrameRef.current = requestAnimationFrame(() => {
        const pending = pendingBrushUpdateRef.current;
        brushMoveFrameRef.current = null;
        if (!pending) return;
        brushPixelEndRef.current = pending.pixel;
        brushEndRef.current = pending.data;
        applyBrushOverlay();
      });
    }
  }, [isBrushing, activeDomain, applyBrushOverlay]);

  const handleContainerMouseUp = useCallback(() => {
    const start = brushStartRef.current;
    const end = brushEndRef.current;
    if (!isBrushing || !start || !end) {
      setIsBrushing(false);
      brushStartRef.current = null;
      brushEndRef.current = null;
      brushPixelStartRef.current = null;
      brushPixelEndRef.current = null;
      if (brushOverlayRef.current) brushOverlayRef.current.style.display = 'none';
      return;
    }

    const xMin = Math.min(start.x, end.x);
    const xMax = Math.max(start.x, end.x);
    const yMin = Math.min(start.y, end.y);
    const yMax = Math.max(start.y, end.y);

    // 需要有一定的选择范围才触发缩放（基于当前视图范围的 2%）
    const currentDomain = activeDomain ?? dataBounds;
    const xRange = currentDomain ? currentDomain.x[1] - currentDomain.x[0] : 1;
    const yRange = currentDomain ? currentDomain.y[1] - currentDomain.y[0] : 1;
    
    if ((xMax - xMin) > xRange * 0.02 && (yMax - yMin) > yRange * 0.02) {
      setZoomDomain({ x: [xMin, xMax], y: [yMin, yMax] });
      setZoomSource('brush'); // 主图框选缩放
    }

    setIsBrushing(false);
    brushStartRef.current = null;
    brushEndRef.current = null;
    brushPixelStartRef.current = null;
    brushPixelEndRef.current = null;
    if (brushOverlayRef.current) brushOverlayRef.current.style.display = 'none';
  }, [isBrushing, activeDomain, dataBounds]);

  // 组件卸载时取消 rAF，避免遗留任务
  useEffect(() => {
    return () => {
      if (brushMoveFrameRef.current != null) {
        cancelAnimationFrame(brushMoveFrameRef.current);
      }
      if (xRangeUpdateFrameRef.current != null) {
        cancelAnimationFrame(xRangeUpdateFrameRef.current);
      }
    };
  }, []);

  // 重置缩放
  const resetZoom = useCallback(() => {
    setZoomDomain(null);
    setZoomSource(null);
  }, []);

  // X 轴范围选择器事件处理（仅支持拖动左右边界）
  const handleXRangeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!xRangeContainerRef.current || !dataBounds) return;
    
    const rect = xRangeContainerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    
    // 获取当前选择范围（如果没有则使用完整范围）
    const currentSelection = zoomDomain?.x ?? dataBounds.x;
    const selectionStartRatio = (currentSelection[0] - dataBounds.x[0]) / (dataBounds.x[1] - dataBounds.x[0]);
    const selectionEndRatio = (currentSelection[1] - dataBounds.x[0]) / (dataBounds.x[1] - dataBounds.x[0]);
    const selectionStartPx = selectionStartRatio * rect.width;
    const selectionEndPx = selectionEndRatio * rect.width;
    const handleSize = 12;
    
    // 只要点击了范围选择器，就切换到 range 模式，确保 Y 轴自适应生效
    setZoomSource('range');

    // 检查是否在左边缘
    if (Math.abs(mouseX - selectionStartPx) < handleSize) {
      setXRangeDragType('left');
      setIsXRangeDragging(true);
      setXRangeDragStartX(mouseX);
      setXRangeOriginalDomain(currentSelection);
      return;
    }
    // 检查是否在右边缘
    if (Math.abs(mouseX - selectionEndPx) < handleSize) {
      setXRangeDragType('right');
      setIsXRangeDragging(true);
      setXRangeDragStartX(mouseX);
      setXRangeOriginalDomain(currentSelection);
      return;
    }
    // 检查是否在选择框内（可拖动移动）
    if (mouseX > selectionStartPx && mouseX < selectionEndPx) {
      setXRangeDragType('move');
      setIsXRangeDragging(true);
      setXRangeDragStartX(mouseX);
      setXRangeOriginalDomain(currentSelection);
      return;
    }
    
    // 点击空白区域：将选择框中心跳转到点击位置
    const clickRatio = mouseX / rect.width;
    const clickTime = dataBounds.x[0] + clickRatio * (dataBounds.x[1] - dataBounds.x[0]);
    const rangeSize = currentSelection[1] - currentSelection[0];
    const halfRange = rangeSize / 2;
    
    let newStart = clickTime - halfRange;
    let newEnd = clickTime + halfRange;
    
    // 限制在数据范围内
    if (newStart < dataBounds.x[0]) {
      newStart = dataBounds.x[0];
      newEnd = dataBounds.x[0] + rangeSize;
    }
    if (newEnd > dataBounds.x[1]) {
      newEnd = dataBounds.x[1];
      newStart = dataBounds.x[1] - rangeSize;
    }
    
    setZoomDomain(prev => prev 
      ? { ...prev, x: [newStart, newEnd] } 
      : { x: [newStart, newEnd], y: dataBounds.y }
    );
  }, [dataBounds, zoomDomain]);

  // X 轴范围选择器滚轮缩放 - 使用原生事件以支持 preventDefault
  useEffect(() => {
    const container = xRangeContainerRef.current;
    if (!container || !dataBounds) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseRatio = clamp(mouseX / rect.width, 0, 1);
      const mouseTime = dataBounds.x[0] + mouseRatio * (dataBounds.x[1] - dataBounds.x[0]);
      
      const currentSelection = zoomDomain?.x ?? dataBounds.x;
      const currentRange = currentSelection[1] - currentSelection[0];
      const fullRange = dataBounds.x[1] - dataBounds.x[0];
      
      // 缩放因子：滚轮向上缩小范围，向下扩大范围
      const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85;
      let newRange = currentRange * zoomFactor;
      
      // 限制最小范围为总范围的 2%，最大为完整范围
      const minRange = fullRange * 0.02;
      newRange = clamp(newRange, minRange, fullRange);
      
      // 以鼠标位置为锚点进行缩放
      const leftRatio = (mouseTime - currentSelection[0]) / currentRange;
      const rightRatio = (currentSelection[1] - mouseTime) / currentRange;
      
      let newStart = mouseTime - newRange * leftRatio;
      let newEnd = mouseTime + newRange * rightRatio;
      
      // 限制在数据范围内
      if (newStart < dataBounds.x[0]) {
        newStart = dataBounds.x[0];
        newEnd = dataBounds.x[0] + newRange;
      }
      if (newEnd > dataBounds.x[1]) {
        newEnd = dataBounds.x[1];
        newStart = dataBounds.x[1] - newRange;
      }
      
      // 如果缩放到接近完整范围，则重置
      if (newRange >= fullRange * 0.98) {
        setZoomDomain(null);
        setZoomSource(null);
      } else {
        setZoomDomain(prev => prev 
          ? { ...prev, x: [newStart, newEnd] } 
          : { x: [newStart, newEnd], y: dataBounds.y }
        );
        setZoomSource('range');
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [dataBounds, zoomDomain]);

  // 全局鼠标事件处理，支持拖出容器范围
  useEffect(() => {
    if (!isXRangeDragging) return;

    const handleMouseMoveRaw = (e: MouseEvent) => {
      if (!xRangeContainerRef.current || !dataBounds || !xRangeOriginalDomain) return;
      
      const rect = xRangeContainerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      // 允许拖出容器，但限制 xRatio 在合理范围内（虽然 clamp 限制了 0-1，但计算 delta 时可以用原始值）
      // 这里我们仍然 clamp xRatio 用于计算 xValue，但对于 move 操作，我们需要未 clamp 的 delta
      
      const xRatio = clamp(mouseX / rect.width, 0, 1);
      const xValue = dataBounds.x[0] + xRatio * (dataBounds.x[1] - dataBounds.x[0]);
      
      const minRange = (dataBounds.x[1] - dataBounds.x[0]) * 0.02; // 最小范围 2%
      
      if (xRangeDragType === 'left') {
        const newStart = Math.min(xValue, xRangeOriginalDomain[1] - minRange);
        const clampedStart = Math.max(newStart, dataBounds.x[0]);
        scheduleXRangeUpdate([clampedStart, xRangeOriginalDomain[1]]);
      } else if (xRangeDragType === 'right') {
        const newEnd = Math.max(xValue, xRangeOriginalDomain[0] + minRange);
        const clampedEnd = Math.min(newEnd, dataBounds.x[1]);
        scheduleXRangeUpdate([xRangeOriginalDomain[0], clampedEnd]);
      } else if (xRangeDragType === 'move' && xRangeDragStartX !== null) {
        const deltaX = mouseX - xRangeDragStartX;
        const deltaRatio = deltaX / rect.width;
        const deltaValue = deltaRatio * (dataBounds.x[1] - dataBounds.x[0]);
        const rangeSize = xRangeOriginalDomain[1] - xRangeOriginalDomain[0];
        
        let newStart = xRangeOriginalDomain[0] + deltaValue;
        let newEnd = xRangeOriginalDomain[1] + deltaValue;
        
        // 限制在数据范围内
        if (newStart < dataBounds.x[0]) {
          newStart = dataBounds.x[0];
          newEnd = dataBounds.x[0] + rangeSize;
        }
        if (newEnd > dataBounds.x[1]) {
          newEnd = dataBounds.x[1];
          newStart = dataBounds.x[1] - rangeSize;
        }
        
        scheduleXRangeUpdate([newStart, newEnd]);
      }
    };

    const handleMouseUp = () => {
      // 检查当前选择范围是否已覆盖完整数据范围，如果是则重置
      if (dataBounds && zoomDomain) {
        const fullRange = dataBounds.x[1] - dataBounds.x[0];
        const startNearBound = Math.abs(zoomDomain.x[0] - dataBounds.x[0]) < fullRange * 0.001;
        const endNearBound = Math.abs(zoomDomain.x[1] - dataBounds.x[1]) < fullRange * 0.001;
        
        if (startNearBound && endNearBound) {
          setZoomDomain(null);
          setZoomSource(null);
        }
      }
      
      setIsXRangeDragging(false);
      setXRangeDragType(null);
      setXRangeDragStartX(null);
      setXRangeOriginalDomain(null);
    };

    window.addEventListener('mousemove', handleMouseMoveRaw);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMoveRaw);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isXRangeDragging, dataBounds, xRangeDragType, xRangeDragStartX, xRangeOriginalDomain, zoomDomain, scheduleXRangeUpdate]);

  // 当数据变化时重置缩放
  useEffect(() => {
    setZoomDomain(null);
    setZoomSource(null);
  }, [points]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "rangeSelection") return;
      const raw = e.newValue;
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Partial<RangeSelection>;
        if (!parsed) return;
        const next: RangeSelection = {
          mode: parsed.mode === "custom" ? "custom" : "preset",
          days: Number.isFinite(parsed.days) ? Math.max(1, Number(parsed.days)) : rangeDays,
          start: parsed.start || customStart,
          end: parsed.end || customEnd
        };
        setGlobalSelection(next);
        if (selectionSource === "global") {
          setRangeMode(next.mode);
          setRangeDays(next.days);
          setCustomStart(next.start);
          setCustomEnd(next.end);
          setAppliedDays(next.days);
        }
      } catch (err) {
        console.warn("Failed to sync rangeSelection", err);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [selectionSource, rangeDays, customStart, customEnd]);

  useEffect(() => {
    if (rangeMode === "custom" && (!customStart || !customEnd)) return;

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (rangeMode === "custom") {
          params.set("start", customStart);
          params.set("end", customEnd);
        } else {
          params.set("days", String(rangeDays));
        }

        const res = await fetch(`/api/explore?${params.toString()}`, { cache: "no-store" });
        const json: ExploreResponse = await res.json();

        if (!res.ok) {
          throw new Error(json?.error || res.statusText);
        }

        if (!cancelled) {
          setData(json);
          setAppliedDays(json.days ?? rangeDays);
        }
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
  }, [rangeMode, customStart, customEnd, rangeDays]);

  const models = useMemo(() => {
    const set = new Set<string>();
    for (const p of points) {
      if (p.model) set.add(p.model);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [points]);

  const isUsingGlobalRange = selectionSource === "global";

  const presetDateLabel = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - Math.max(0, appliedDays - 1) * DAY_MS);
    return `${formatDateInputValue(start)} ~ ${formatDateInputValue(end)}`;
  }, [appliedDays]);

  const rangeSubtitle = useMemo(() => {
    if (rangeMode === "custom" && customStart && customEnd) {
      return `${customStart} ~ ${customEnd}${isUsingGlobalRange ? "（跟随仪表盘）" : ""}`;
    }
    return `${presetDateLabel}${isUsingGlobalRange ? "（跟随仪表盘）" : ""}`;
  }, [rangeMode, customStart, customEnd, isUsingGlobalRange, presetDateLabel]);

  // 计算堆叠面积图数据（按时间分组，各模型 token 累计）
  const stackedAreaData = useMemo(() => {
    if (!activeDomain || filteredPoints.length === 0 || models.length === 0) return [];
    
    const [xMin, xMax] = activeDomain.x;
    const rangeMs = xMax - xMin;
    if (!Number.isFinite(rangeMs) || rangeMs <= 0) return [];

    // 固定时间粒度 + 对齐边界：避免时间范围轻微变化导致所有桶整体漂移。
    const targetBins = 60;
    const niceIntervalsMs = [
      1 * 60_000,
      2 * 60_000,
      5 * 60_000,
      10 * 60_000,
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
      2 * 60 * 60_000,
      3 * 60 * 60_000,
      6 * 60 * 60_000,
      12 * 60 * 60_000,
      24 * 60 * 60_000,
      2 * 24 * 60 * 60_000,
      7 * 24 * 60 * 60_000
    ];

    const ideal = rangeMs / targetBins;
    const intervalMs = niceIntervalsMs.find((v) => v >= ideal) ?? niceIntervalsMs[niceIntervalsMs.length - 1];

    const startIndex = Math.floor(xMin / intervalMs);
    const endIndex = Math.ceil(xMax / intervalMs);
    const binCount = Math.max(1, endIndex - startIndex);

    // 初始化每个时间桶的模型累计（ts 为桶中心点）
    const bins: Array<Record<string, number> & { ts: number }> = [];
    for (let i = 0; i < binCount; i++) {
      const bucketStart = (startIndex + i) * intervalMs;
      const bin: Record<string, number> & { ts: number } = { ts: bucketStart + intervalMs / 2 };
      for (const m of models) bin[m] = 0;
      bins.push(bin);
    }

    // 累加每个点到对应的桶（按绝对时间对齐）
    for (const p of filteredPoints) {
      if (p.ts < xMin || p.ts > xMax) continue;
      if (!p.model) continue;
      const idx = Math.floor(p.ts / intervalMs) - startIndex;
      if (idx < 0 || idx >= binCount) continue;
      bins[idx][p.model] = (bins[idx][p.model] || 0) + p.tokens;
    }

    return bins;
  }, [activeDomain, filteredPoints, models]);

  // 堆叠面积图的最大值（用于归一化到左Y轴）
  const stackedMaxSum = useMemo((): number => {
    if (stackedAreaData.length === 0 || models.length === 0) return 1;
    let maxSum = 0;
    for (const bin of stackedAreaData) {
      let sum = 0;
      for (const m of models) {
        sum += bin[m] || 0;
      }
      maxSum = Math.max(maxSum, sum);
    }
    return maxSum || 1;
  }, [stackedAreaData, models]);

  // 缓存 Y 轴刻度文本，减少 tickFormatter 的重复计算
  const yTickLabelMap = useMemo(() => {
    if (!computedYTicks) return null;

    const labels = new Map<number, string>();
    for (const tick of computedYTicks) {
      const num = Number(tick);
      if (num < 0) continue;
      const scatterLabel = formatCompactNumber(num);

      if (showStackedArea && activeDomain) {
        const scatterTop = activeDomain.y[1] || 1;
        const stackedValue = (num / scatterTop) * stackedMaxSum;
        labels.set(num, `${scatterLabel} (${formatCompactNumber(stackedValue)})`);
      } else {
        labels.set(num, scatterLabel);
      }
    }
    return labels;
  }, [computedYTicks, showStackedArea, activeDomain, stackedMaxSum]);

  // 归一化堆叠数据 - 将堆叠值映射到散点图 Y 轴范围
  const normalizedStackedData = useMemo(() => {
    if (!showStackedArea || stackedAreaData.length === 0 || !activeDomain) return stackedAreaData;
    
    const scatterYMax = activeDomain.y[1];
    const scale = scatterYMax / stackedMaxSum;
    
    return stackedAreaData.map(bin => {
      const normalized: Record<string, number> & { ts: number } = { ts: bin.ts };
      for (const m of models) {
        normalized[m] = (bin[m] || 0) * scale;
      }
      return normalized;
    });
  }, [showStackedArea, stackedAreaData, stackedMaxSum, activeDomain, models]);

  // 性能优化：只渲染可视范围内的堆叠面积数据
  const visibleStackedData = useMemo(() => {
    if (!activeDomain) return normalizedStackedData;
    const [xMin, xMax] = activeDomain.x;
    return normalizedStackedData.filter(d => 
      d.ts >= xMin && d.ts <= xMax
    );
  }, [normalizedStackedData, activeDomain]);

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

  // 使用 ref 存储高亮状态，避免 dotShape 因高亮变化而重建
  const highlightedModelRef = useRef(highlightedModel);
  const zoomSourceRef = useRef(zoomSource);
  
  useEffect(() => {
    highlightedModelRef.current = highlightedModel;
  }, [highlightedModel]);
  
  useEffect(() => {
    zoomSourceRef.current = zoomSource;
  }, [zoomSource]);

  const mainChartMargin = useMemo(() => ({
    ...CHART_MARGIN,
    top: CHART_MARGIN.top + CHART_TOP_INSET
  }), []);

  const cartesianGridProps = useMemo(() => ({
    yAxisId: "left",
    strokeDasharray: "3 3",
    stroke: "#64748b",
    strokeOpacity: 0.6,
    horizontal: true,
    vertical: true
  }), []);

  // 散点图点形状组件 - 仅依赖 modelColorMap，其他通过 ref 访问
  const dotShape = useMemo(() => {
    return function Dot(props: any) {
      const { cx, cy, payload } = props;
      if (cx == null || cy == null) return <g />;
      const model = String(payload?.model ?? "");
      const fill = modelColorMap.get(model) ?? MODEL_COLORS[0];
      const currentHighlighted = highlightedModelRef.current;
      const currentZoomSource = zoomSourceRef.current;
      const isHighlighted = currentHighlighted === model;
      
      // 仅框选缩放（brush）时放大点，范围选择器缩放不放大
      const baseRadius = currentZoomSource === 'brush' ? 5 : 3;
      const radius = isHighlighted ? baseRadius + 1 : baseRadius;
      
      return (
        <g style={{ cursor: 'pointer' }}>
          {/* 透明扩大点击区域 */}
          <circle 
            cx={cx} 
            cy={cy} 
            r={radius + 3} 
            fill="transparent"
          />
          {/* 可见的点 */}
          <circle 
            cx={cx} 
            cy={cy} 
            r={radius} 
            fill={fill} 
            fillOpacity={currentHighlighted && !isHighlighted ? 0.15 : 0.68}
            stroke={isHighlighted ? "#ffffffce" : "none"}
            strokeWidth={isHighlighted ? 1.2 : 0}
          />
        </g>
      );
    };
  }, [modelColorMap]);

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

  const clearHover = useCallback(() => {
    scatterTooltipRef.current?.hide();
  }, []);

  const commitHover = useCallback((payload: ExplorePoint, x: number, y: number) => {
    scatterTooltipRef.current?.show(payload, x, y);
  }, []);

  const applyPresetRange = useCallback((days: number) => {
    setSelectionSource("local");
    setRangeMode("preset");
    setRangeDays(days);
    setAppliedDays(days);
    setCustomPickerOpen(false);
    setCustomError(null);
  }, []);

  const applyCustomRange = useCallback(() => {
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
    setSelectionSource("local");
    setRangeMode("custom");
    setCustomStart(customDraftStart);
    setCustomEnd(customDraftEnd);
    const days = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1);
    setRangeDays(days);
    setAppliedDays(days);
    setCustomPickerOpen(false);
  }, [customDraftStart, customDraftEnd]);

  const applyDashboardRange = useCallback(() => {
    const next = globalSelection;
    setSelectionSource("global");
    setRangeMode(next.mode);
    setRangeDays(next.days);
    setCustomStart(next.start);
    setCustomEnd(next.end);
    setAppliedDays(next.days);
    setCustomPickerOpen(false);
    setCustomError(null);
  }, [globalSelection]);

    return (
      <main className="min-h-screen bg-slate-900 px-3 sm:px-6 pb-4 pt-6 sm:pt-8 text-slate-100">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">数据探索</h1>
          <p className="text-base text-slate-400">每个点代表一次请求（X=时间，Y=token 数，颜色=模型）</p>
        </div>
        <div className="flex flex-col items-start gap-2 text-sm text-slate-300 md:items-end">
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {[7, 14, 30].map((days) => (
              <button
                key={days}
                onClick={() => applyPresetRange(days)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  rangeMode === "preset" && selectionSource === "local" && rangeDays === days
                    ? "border-indigo-500 bg-indigo-500/20 text-indigo-100"
                    : "border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500"
                }`}
              >
                最近 {days} 天
              </button>
            ))}
            <div className="relative">
              <button
                onClick={() => {
                  setCustomPickerOpen((open) => !open);
                  setCustomDraftStart(customStart);
                  setCustomDraftEnd(customEnd);
                }}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  rangeMode === "custom" && selectionSource === "local"
                    ? "border-indigo-500 bg-indigo-500/20 text-indigo-100"
                    : "border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500"
                }`}
              >
                自定义
              </button>
              {customPickerOpen ? (
                <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
                  <div className="space-y-3 text-sm">
                    <div className="grid grid-cols-1 gap-2">
                      <label className="text-slate-300">
                        开始日期
                        <input
                          type="date"
                          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                          value={customDraftStart}
                          max={customDraftEnd || undefined}
                          onChange={(e) => setCustomDraftStart(e.target.value)}
                        />
                      </label>
                      <label className="text-slate-300">
                        结束日期
                        <input
                          type="date"
                          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                          value={customDraftEnd}
                          min={customDraftStart || undefined}
                          onChange={(e) => setCustomDraftEnd(e.target.value)}
                        />
                      </label>
                    </div>
                    {customError ? <p className="text-xs text-red-400">{customError}</p> : null}
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setCustomPickerOpen(false);
                          setCustomError(null);
                          setCustomDraftStart(customStart);
                          setCustomDraftEnd(customEnd);
                        }}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={applyCustomRange}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        应用
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <button
              onClick={applyDashboardRange}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                selectionSource === "global"
                  ? "border-emerald-500 bg-emerald-500/20 text-emerald-100"
                  : "border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500"
              }`}
            >
              跟随仪表盘
            </button>
          </div>
          <div className="text-xs text-slate-400">
            <span className="text-slate-500">时间范围：</span>
            <span>{rangeSubtitle}</span>
            {data?.step && data.step > 1 ? <span className="ml-3 text-slate-500">{`已抽样：每 ${data.step} 个点取 1 个`}</span> : null}
          </div>
        </div>
      </header>

      <section className="mt-6 rounded-2xl bg-slate-950/40 p-5 ring-1 ring-slate-800">
        <div className="flex min-h-[28px] flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300">
          <div>
            <span className="text-slate-400">总点数：</span>
            <span>{formatNumberWithCommas(data?.total ?? 0)}</span>
          </div>
          <div>
            <span className="text-slate-400">渲染点数：</span>
            <span>{formatNumberWithCommas(visiblePoints.length)}</span>
          </div>
          {zoomDomain && dataBounds && (() => {
            const totalXRange = dataBounds.x[1] - dataBounds.x[0];
            const zoomXRange = zoomDomain.x[1] - zoomDomain.x[0];
            const zoomRatio = totalXRange > 0 ? zoomXRange / totalXRange : 1;
            return zoomRatio < 0.999;
          })() && (
            <button
              type="button"
              onClick={resetZoom}
              className="rounded-lg bg-slate-600/90 px-3 py-1 text-xs text-slate-100 transition-colors hover:bg-slate-500"
            >
              重置缩放
            </button>
          )}
          <div className="ml-auto flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400 hover:text-slate-300">
              <button
                type="button"
                role="switch"
                aria-checked={showStackedArea}
                onClick={() => setShowStackedArea(!showStackedArea)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                  showStackedArea ? 'bg-blue-500' : 'bg-slate-600'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                    showStackedArea ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
              <span>模型堆叠分布图</span>
            </label>
            <span className="text-xs text-slate-500">提示：拖拽框选可缩放区域</span>
          </div>
        </div>

        <ModelLegend
          models={models}
          hiddenModels={hiddenModels}
          getModelColor={getModelColor}
          onMouseEnter={handleLegendMouseEnter}
          onMouseLeave={handleLegendMouseLeave}
          onClick={handleLegendClick}
        />

        <div className="mt-4 flex h-[75vh] flex-col gap-0">
          {loading ? (
            <Skeleton className="h-full" />
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 text-center">
                  <p className="text-base text-slate-200">加载失败</p>
                  <p className="mt-1 text-sm text-slate-400">{error}</p>
            </div>
          ) : points.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 text-center">
                  <p className="text-base text-slate-200">暂无请求明细数据</p>
                  <p className="mt-1 text-sm text-slate-400">如果上游 /usage 未提供 details，此图会为空。</p>
            </div>
          ) : (
            <>
            {/* 主图表区域 */}
            <div className="relative flex flex-1 gap-0">
              {/* Y 轴分布面积图（竖向，波峰朝左）- 使用绝对定位精确对齐 */}
              <div 
                className="absolute left-0 w-16 pointer-events-none"
                style={{ 
                  top: CHART_MARGIN.top + CHART_TOP_INSET - 2, 
                  height: `calc(94.5% - ${CHART_MARGIN.top + CHART_TOP_INSET}px - ${CHART_MARGIN.bottom}px)` 
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
                        <stop offset="40%" stopColor="#60a5fa" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.7} />
                      </linearGradient>
                    </defs>
                    <XAxis type="number" hide domain={[0, 'dataMax']} reversed />
                    <YAxis type="category" dataKey="y" hide />
                    <Area 
                      type="basis" 
                        dataKey="count" 
                        stroke="#7cc5ff" 
                        strokeWidth={1.5}
                        strokeOpacity={0.75}
                      fill="url(#yDistGradient)" 
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              
              {/* 主散点图 - 左侧留出面积图的空间 */}
              <div 
                ref={chartContainerRef} 
                className="relative flex-1 select-none focus:outline-none focus-visible:outline-none"
                style={{ marginLeft: 64 }}
                tabIndex={-1}
                onMouseDown={handleContainerMouseDown}
                onMouseMove={handleContainerMouseMoveWithRaf}
                onMouseUp={handleContainerMouseUp}
                onMouseLeave={() => {
                  handleContainerMouseUp();
                  clearHover();
                }}
                onDoubleClick={zoomDomain ? resetZoom : undefined}
              >
                {/* Brush 选择区域可视化 - DOM 直接更新避免频繁重渲染 */}
                <div
                  ref={brushOverlayRef}
                  className="pointer-events-none absolute border border-blue-400/80 bg-blue-400/15"
                  style={{ display: 'none' }}
                />
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart 
                  margin={mainChartMargin}
                  data={visibleStackedData}
                  onMouseLeave={clearHover}
                >
                    <XAxis
                      type="number"
                      dataKey="ts"
                      domain={activeDomain?.x}
                      scale="time"
                      tickFormatter={(v) => formatTs(Number(v))}
                      stroke="#cbd5e1"
                      fontSize={13}
                      allowDataOverflow
                      axisLine={false}
                      ticks={computedXTicks}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      yAxisId="left"
                      type="number"
                      dataKey="tokens"
                      domain={smoothYDomain || activeDomain?.y}
                      stroke="#cbd5e1"
                      fontSize={13}
                      ticks={computedYTicks}
                      interval="preserveStartEnd"
                      tickMargin={6}
                      tickFormatter={(v) => {
                        const num = Number(v);
                        const cached = yTickLabelMap?.get(num);
                        if (cached !== undefined) return cached;
                        if (num < 0) return '';
                        return formatCompactNumber(num);
                      }}
                      allowDataOverflow
                    />
                    {/* 堆叠面积图 - 在散点下方作为背景 */}
                    {showStackedArea && models.map((model) => (
                      <Area
                        key={model}
                        yAxisId="left"
                        type="monotone"
                        dataKey={model}
                        stackId="tokens"
                        stroke="none"
                        fill={getModelColor(model)}
                        fillOpacity={
                          hiddenModels.has(model) 
                            ? 0 
                            : highlightedModel === null || highlightedModel === model
                              ? 0.3
                              : 0.1
                        }
                        isAnimationActive={false}
                      />
                    ))}
                  <CartesianGrid {...cartesianGridProps} />
                  <Tooltip
                    cursor={false}
                    content={() => null}
                  />
                  <ReferenceLine 
                    yAxisId="left"
                    y={0} 
                    stroke="#cbd5e1aa" 
                    strokeWidth={1} 
                    ifOverflow="extendDomain"
                  />
                  <Scatter 
                    yAxisId="left" 
                    data={visiblePoints} 
                    shape={dotShape} 
                    isAnimationActive={false}
                    onMouseEnter={(entry: any, _index: number, e: React.MouseEvent) => {
                      if (entry && 'inputTokens' in entry) {
                        commitHover(entry as ExplorePoint, e.clientX, e.clientY);
                      }
                    }}
                    onMouseLeave={clearHover}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              
              </div>
            </div>
            
            {/* X 轴范围选择器 */}
            <div 
              className="relative mt-1 h-16 select-none"
              style={{ marginLeft: 132 , marginRight: 12 }}
            >
              <div 
                ref={xRangeContainerRef}
                className="relative h-10 w-full cursor-ew-resize overflow-visible rounded-lg bg-slate-950/40 ring-1 ring-slate-800/80 transition-colors"
                onMouseDown={handleXRangeMouseDown}
                onMouseLeave={() => !isXRangeDragging && setXRangeHover(null)}
                onDoubleClick={zoomDomain ? resetZoom : undefined}
              >
                {/* 背景面积图 */}
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart 
                    data={xDistribution} 
                    margin={{ top: 2, right: 0, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="xDistGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <XAxis type="number" dataKey="ts" domain={dataBounds?.x} hide />
                    <YAxis type="number" dataKey="tokens" hide domain={[0, 'dataMax']} />
                    <Area 
                      type="monotone" 
                      dataKey="tokens" 
                      stroke="#7cc5ff" 
                      strokeWidth={1.5}
                      strokeOpacity={0.8}
                      fill="url(#xDistGradient)" 
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
                
                {/* 选择区域遮罩和手柄 - 始终显示，默认覆盖全范围 */}
                {dataBounds && (() => {
                  const currentSelection = zoomDomain?.x ?? dataBounds.x;
                  const startRatio = (currentSelection[0] - dataBounds.x[0]) / (dataBounds.x[1] - dataBounds.x[0]);
                  const endRatio = (currentSelection[1] - dataBounds.x[0]) / (dataBounds.x[1] - dataBounds.x[0]);
                  const hasZoom = zoomDomain !== null;
                  const showLeftLabel = xRangeHover === 'left' || xRangeHover === 'box' || isXRangeDragging;
                  const showRightLabel = xRangeHover === 'right' || xRangeHover === 'box' || isXRangeDragging;
                  
                  return (
                    <>
                      {/* 左侧灰色区域 */}
                      {startRatio > 0.001 && (
                        <div 
                          className="pointer-events-none absolute top-0 h-full rounded-l-lg bg-slate-950/55"
                          style={{
                            left: 0,
                            width: `${startRatio * 100}%`,
                          }}
                        />
                      )}
                      {/* 右侧灰色区域 */}
                      {endRatio < 0.999 && (
                        <div 
                          className="pointer-events-none absolute top-0 h-full rounded-r-lg bg-slate-950/55"
                          style={{
                            left: `${endRatio * 100}%`,
                            right: 0,
                          }}
                        />
                      )}
                      
                      {/* 选择框（可拖动移动）*/}
                      <div 
                        className={`absolute top-0 h-full cursor-move border-y transition-[background-color,border-color] duration-150 hover:bg-blue-500/10 active:bg-blue-500/15 ${hasZoom ? 'border-blue-500/50 border-l border-r rounded-lg' : 'border-blue-500/25'}`}
                        style={{
                          left: `${startRatio * 100}%`,
                          width: `${(endRatio - startRatio) * 100}%`,
                        }}
                        onMouseEnter={() => setXRangeHover('box')}
                      />

                      {/* 左侧拖动手柄 */}
                      <div 
                        className="group absolute top-0 z-10 flex h-full w-5 -translate-x-1/2 cursor-ew-resize items-center justify-center"
                        style={{ left: `${startRatio * 100}%` }}
                        onMouseEnter={() => setXRangeHover('left')}
                      >
                        <div className="h-6 w-1.5 rounded-full bg-slate-200/90 ring-1 ring-slate-950/80 shadow-none transition-[background-color,width] duration-150 group-hover:w-2 group-hover:bg-slate-50" />
                        {/* 时间标签 - 仅 hover 或拖动时显示 */}
                        <div className={`absolute bottom-full mb-1 whitespace-nowrap rounded-md bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 ring-1 ring-slate-700/60 transition-opacity duration-150 ${showLeftLabel ? 'opacity-100' : 'opacity-0'}`}>
                          {formatTs(currentSelection[0])}
                        </div>
                      </div>

                      {/* 右侧拖动手柄 */}
                      <div 
                        className="group absolute top-0 z-10 flex h-full w-5 -translate-x-1/2 cursor-ew-resize items-center justify-center"
                        style={{ left: `${endRatio * 100}%` }}
                        onMouseEnter={() => setXRangeHover('right')}
                      >
                        <div className="h-6 w-1.5 rounded-full bg-slate-200/90 ring-1 ring-slate-950/80 shadow-none transition-[background-color,width] duration-150 group-hover:w-2 group-hover:bg-slate-50" />
                        {/* 时间标签 - 仅 hover 或拖动时显示 */}
                        <div className={`absolute bottom-full mb-1 whitespace-nowrap rounded-md bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 ring-1 ring-slate-700/60 transition-opacity duration-150 ${showRightLabel ? 'opacity-100' : 'opacity-0'}`}>
                          {formatTs(currentSelection[1])}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
            </>
          )}
        </div>
      </section>
      <ScatterTooltip ref={scatterTooltipRef} getModelColor={getModelColor} />
    </main>
  );
}
