"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, FileText, Activity, LogOut, Github, ExternalLink, Table, Menu, X, Radio } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { Modal } from "./Modal";

const links = [
  { href: "/", label: "仪表盘", icon: BarChart3 },
  { href: "/explore", label: "数据探索", icon: Activity },
  { href: "/channels", label: "渠道统计", icon: Radio },
  { href: "/records", label: "调用记录", icon: Table },
  { href: "/logs", label: "日志", icon: FileText }
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [usageStatsEnabled, setUsageStatsEnabled] = useState<boolean | null>(null);
  const [usageStatsLoading, setUsageStatsLoading] = useState(false);
  const [showUsageConfirm, setShowUsageConfirm] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [cpamcLink, setCpamcLink] = useState<string | null>(null);

  const loadToggle = useCallback(async () => {
    setUsageStatsLoading(true);
    try {
      const res = await fetch("/api/usage-statistics-enabled", { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      const data = await res.json();
      setUsageStatsEnabled(Boolean(data["usage-statistics-enabled"]));
    } catch {
      setUsageStatsEnabled(null);
    } finally {
      setUsageStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadToggle();
  }, [loadToggle]);

  useEffect(() => {
    let active = true;
    const loadCpamc = async () => {
      try {
        const res = await fetch("/api/management-url", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!active) return;
        setCpamcLink(typeof data?.url === "string" ? data.url : null);
      } catch {
        if (!active) return;
        setCpamcLink(null);
      }
    };

    loadCpamc();
    return () => {
      active = false;
    };
  }, []);

  const applyUsageToggle = async (nextEnabled: boolean) => {
    setUsageStatsLoading(true);
    try {
      const res = await fetch("/api/usage-statistics-enabled", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: nextEnabled })
      });
      if (!res.ok) throw new Error("toggle failed");
      const data = await res.json();
      setUsageStatsEnabled(Boolean(data["usage-statistics-enabled"]));
    } catch {
      // ignore
    } finally {
      setUsageStatsLoading(false);
    }
  };

  const handleUsageToggle = () => {
    if (usageStatsEnabled === null) return;
    const nextEnabled = !usageStatsEnabled;
    if (!nextEnabled) {
      setShowUsageConfirm(true);
      return;
    }
    applyUsageToggle(nextEnabled);
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      setLoggingOut(false);
    }
  };

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-56 flex-col border-r border-slate-800 bg-slate-950 py-6">
      <div className="px-5">
        <h1 className="text-xl font-bold text-white">CLIProxyAPI</h1>
        <p className="text-sm text-slate-500">Usage Dashboard</p>
      </div>
      <nav className="mt-8 flex-1 space-y-1 px-3">
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium transition-colors ${
                active
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}
        {cpamcLink ? (
          <a
            href={cpamcLink}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-base font-medium transition-colors text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <ExternalLink className="h-5 w-5" />
            前往 CPAMC
          </a>
        ) : null}
      </nav>

      <div className="mt-auto border-t border-slate-800 px-4 pt-4 pb-2 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Activity className="h-4 w-4" />
            上游使用统计
          </div>
          <button
            onClick={handleUsageToggle}
            disabled={usageStatsLoading || usageStatsEnabled === null}
            className={`rounded-full px-3 py-1 text-sm font-semibold transition ${
              usageStatsEnabled
                ? "bg-emerald-600 text-white"
                : "border border-slate-600 text-slate-400"
            } ${usageStatsLoading ? "opacity-70" : ""}`}
          >
            {usageStatsLoading ? "..." : usageStatsEnabled ? "ON" : "OFF"}
          </button>
        </div>
        
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/sxjeru/CLIProxyAPI-Monitor"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center rounded-lg border border-slate-700 p-2 text-slate-500 transition hover:bg-slate-800 hover:text-slate-300"
          >
            <Github className="h-4 w-4" />
          </a>
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-50"
          >
            <LogOut className="h-4 w-4" />
            {loggingOut ? "退出中..." : "退出登录"}
          </button>
        </div>
      </div>
      <Modal
        isOpen={showUsageConfirm}
        onClose={() => setShowUsageConfirm(false)}
        title="关闭上游使用统计？"
        darkMode={true}
        className="bg-slate-900 ring-1 ring-slate-700"
        backdropClassName="bg-black/60"
      >
        <p className="mt-2 text-sm text-slate-400">关闭后将停止 CLIProxyAPI 记录使用数据，需要时可再次开启。</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setShowUsageConfirm(false)}
            className="flex-1 rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              setShowUsageConfirm(false);
              applyUsageToggle(false);
            }}
            className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
            disabled={usageStatsLoading}
          >
            确认关闭
          </button>
        </div>
      </Modal>
    </aside>
  );
}
