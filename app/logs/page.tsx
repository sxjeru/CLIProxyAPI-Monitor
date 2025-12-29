"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type LogsResponse = {
  lines?: string[];
  "line-count"?: number;
  "latest-timestamp"?: number;
};

type ErrorLogEntry = {
  name: string;
  size?: number;
  modified?: number;
};

type FetchMode = "full" | "incremental";

// 格式化 Unix 时间戳为人性化时间（中国时区）
function formatTimestamp(ts: number | undefined): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  });
}

// 格式化文件大小
function formatSize(bytes: number | undefined): string {
  if (!bytes) return "? bytes";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-700/50 ${className ?? ""}`} />;
}

export default function LogsPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestTs, setLatestTs] = useState<number | null>(null);
  const [afterInput, setAfterInput] = useState("");
  const [errorLogs, setErrorLogs] = useState<ErrorLogEntry[]>([]);
  const [errorLogContent, setErrorLogContent] = useState<string | null>(null);
  const [errorLogName, setErrorLogName] = useState<string | null>(null);
  const [errorLogLoading, setErrorLogLoading] = useState(false);
  const [errorLogError, setErrorLogError] = useState<string | null>(null);

  // 按时间倒序排序的 errorLogs
  const sortedErrorLogs = useMemo(() => {
    return [...errorLogs].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }, [errorLogs]);

  const latestText = useMemo(() => {
    if (!latestTs) return "无";
    const date = new Date(latestTs * 1000);
    return date.toLocaleString("zh-CN", { 
      month: "2-digit", 
      day: "2-digit", 
      hour: "2-digit", 
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }, [latestTs]);

  // 将日期时间字符串转为 Unix 时间戳
  const parseDateTime = (value: string): number | null => {
    if (!value) return null;
    // 如果是纯数字，当作时间戳
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    // 尝试解析日期时间
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
  };

  // 获取日期时间输入值用于显示
  const getDateTimeInputValue = (): string => {
    if (!afterInput) return "";
    // 如果是时间戳，转换为 datetime-local 格式
    if (/^\d+$/.test(afterInput)) {
      const date = new Date(parseInt(afterInput, 10) * 1000);
      // 格式: YYYY-MM-DDTHH:mm
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    return afterInput;
  };

  const handleDateTimeChange = (value: string) => {
    if (!value) {
      setAfterInput("");
      return;
    }
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      setAfterInput(String(Math.floor(date.getTime() / 1000)));
    }
  };

  const fetchLogs = useCallback(async (mode: FetchMode) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      const afterVal = mode === "incremental" ? afterInput || (latestTs ? String(latestTs) : "") : afterInput;
      if (afterVal) params.set("after", afterVal);

      const res = await fetch(`/api/logs${params.toString() ? `?${params.toString()}` : ""}`, { cache: "no-store" });
      const data: LogsResponse & { error?: string } = await res.json();
      
      if (!res.ok) {
        // 处理特定错误
        if (data.error === "logging to file disabled") {
          setError("文件日志未开启，请在 CLIProxy 配置中启用 logging-to-file");
        } else {
          setError(data.error || res.statusText);
        }
        setLines([]);
        return;
      }
      
      setLines(data.lines ?? []);
      setLatestTs(typeof data["latest-timestamp"] === "number" ? data["latest-timestamp"] : null);
    } catch (err) {
      setError((err as Error).message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [afterInput, latestTs]);

  const fetchErrorLogs = useCallback(async () => {
    setErrorLogLoading(true);
    setErrorLogError(null);
    try {
      const res = await fetch("/api/request-error-logs", { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setErrorLogs(Array.isArray(data?.files) ? data.files : []);
    } catch (err) {
      setErrorLogError((err as Error).message || "加载失败");
    } finally {
      setErrorLogLoading(false);
    }
  }, []);

  const fetchErrorLogFile = useCallback(async (name: string) => {
    setErrorLogLoading(true);
    setErrorLogError(null);
    setErrorLogContent(null);
    try {
      const res = await fetch(`/api/request-error-logs?name=${encodeURIComponent(name)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(res.statusText);
      const text = await res.text();
      setErrorLogName(name);
      setErrorLogContent(text);
    } catch (err) {
      setErrorLogError((err as Error).message || "加载失败");
    } finally {
      setErrorLogLoading(false);
    }
  }, []);

  // 初始加载
  useEffect(() => {
    fetchLogs("full");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchErrorLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen bg-slate-900 px-6 py-8 text-slate-100">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Logs</h1>
          <p className="text-base text-slate-400">展示 /logs 最新输出，未持久化</p>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <button
            onClick={() => fetchLogs("full")}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-semibold hover:border-slate-500"
            title="重新加载所有日志（可通过起始时间筛选）"
          >
            重新加载
          </button>
          <button
            onClick={() => fetchLogs("incremental")}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 font-semibold hover:border-slate-500"
            title="仅获取上次记录之后的新日志"
          >
            获取新日志
          </button>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-slate-300">
        <label className="flex items-center gap-2">
          <span>起始时间</span>
          <input
            type="datetime-local"
            value={getDateTimeInputValue()}
            onChange={(e) => handleDateTimeChange(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
          />
          {afterInput && (
            <button
              onClick={() => setAfterInput("")}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs hover:border-slate-500"
              title="清除"
            >
              清除
            </button>
          )}
        </label>
        <span className="text-slate-400">|</span>
        <span>最新记录: {latestText}</span>
        <span className="text-slate-400">|</span>
        <div className="flex items-center gap-2">
          {[1, 6, 24].map((hours) => (
            <button
              key={hours}
              onClick={() => setAfterInput(String(Math.floor(Date.now() / 1000 - hours * 3600)))}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 font-semibold hover:border-slate-500"
            >
              最近 {hours}h
            </button>
          ))}
        </div>
      </div>

      <section className="mt-4 rounded-2xl bg-slate-800/50 p-4 shadow-sm ring-1 ring-slate-700">
        {error ? <p className="text-base text-red-400">{error}</p> : null}
        {loading ? (
          <Skeleton className="h-40" />
        ) : lines.length === 0 ? (
          <p className="text-base text-slate-400">未读取到日志，检查是否开启“日志到文件”配置项</p>
        ) : (
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900/80 p-4 text-sm text-slate-100">
            {lines.join("\n")}
          </pre>
        )}
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-slate-800/50 p-4 shadow-sm ring-1 ring-slate-700">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">request-error-logs</h2>
            <button
              onClick={fetchErrorLogs}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-semibold hover:border-slate-500"
            >
              刷新列表
            </button>
          </div>
          {errorLogError ? <p className="mt-2 text-sm text-red-400">{errorLogError}</p> : null}
          {errorLogLoading ? (
            <Skeleton className="mt-3 h-24" />
          ) : errorLogs.length === 0 ? (
            <p className="mt-3 text-base text-slate-400">暂无 error log 文件</p>
          ) : (
            <div className="mt-3 divide-y divide-slate-700">
              {sortedErrorLogs.map((file) => (
                <div key={file.name} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-base font-semibold text-white">{file.name}</p>
                    <p className="text-sm text-slate-400">{formatSize(file.size)} • {formatTimestamp(file.modified)}</p>
                  </div>
                  <button
                    onClick={() => fetchErrorLogFile(file.name)}
                    className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm font-semibold hover:border-slate-500"
                  >
                    查看
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-slate-800/50 p-4 shadow-sm ring-1 ring-slate-700">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">error log 内容</h2>
            {errorLogName ? <span className="text-sm text-slate-400">{errorLogName}</span> : null}
          </div>
          {errorLogLoading ? (
            <Skeleton className="mt-3 h-32" />
          ) : errorLogContent ? (
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900/80 p-4 text-sm text-slate-100">
              {errorLogContent}
            </pre>
          ) : (
            <p className="mt-3 text-base text-slate-400">选择一个文件查看内容</p>
          )}
        </div>
      </section>
    </main>
  );
}
