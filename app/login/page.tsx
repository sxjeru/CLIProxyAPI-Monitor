"use client";

import { useState, FormEvent, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LockKeyhole, Clock, Shield } from "lucide-react";

function LoginPageContent() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [lockoutUntil, setLockoutUntil] = useState(0);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);
  const [totalAttempts, setTotalAttempts] = useState(0);
  // 用于触发每秒重渲染并提供当前时间
  const [now, setNow] = useState(() => Date.now());
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/";

  const isLocked = lockoutUntil > now;

  // 锁定倒计时
  useEffect(() => {
    if (!isLocked) {
      return;
    }
    
    const timer = setInterval(() => {
      const currentNow = Date.now();
      setNow(currentNow);
      if (lockoutUntil <= currentNow) {
        setLockoutUntil(0);
        setLoading(false);
        setError("");
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [lockoutUntil, isLocked]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isLocked) return;
    
    setLoading(true);

    try {
      const credentials = btoa(`:${password}`);
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${credentials}`,
          "Content-Type": "application/json"
        }
      });

      const data = await response.json();

      if (response.ok) {
        router.push(from);
        router.refresh();
      } else {
        setError(data.message || data.error || "密码错误");
        
        if (data.isLocked && data.lockoutUntil) {
          setLockoutUntil(data.lockoutUntil);
          setLoading(false);
        } else {
          setRemainingAttempts(data.remainingAttempts ?? null);
          setTotalAttempts(data.totalAttempts ?? 0);
          setLoading(false);
        }
      }
    } catch (err) {
      setError("登录失败，请重试");
      setLoading(false);
    }
  }

  const getRemainingTime = () => {
    const remaining = Math.ceil((lockoutUntil - now) / 1000);
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
      {/* 背景模糊效果 */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-900/20 via-transparent to-transparent" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_var(--tw-gradient-stops))] from-purple-900/20 via-transparent to-transparent" />
      
      {/* 装饰性网格 */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />

      {/* 登录卡片 */}
      <div className="relative z-10 w-full max-w-md px-6">
        <div className="bg-slate-900/80 backdrop-blur-xl rounded-2xl shadow-2xl border border-slate-700/50 p-8">
          {/* Logo 区域 */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg">
              <LockKeyhole className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-100">CLIProxyAPI Dashboard</h1>
            <p className="text-slate-400 mt-2">请输入密码以继续</p>
          </div>

          {/* 登录表单 */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-2">
                密码
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError("");
                }}
                placeholder="输入访问密码"
                className="w-full px-4 py-3 bg-slate-800/50 border border-slate-600 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={loading || isLocked}
                autoFocus
              />
            </div>

            {/* 消息区域 - 使用 transition 避免布局跳动 */}
            <div className={`transition-all duration-300 ease-in-out overflow-hidden ${
              (error && !isLocked) || isLocked 
                ? "max-h-32 opacity-100" 
                : "max-h-0 opacity-0 !mt-0"
            }`}>
              <div className="pb-1"> {/* 底部预留微小间距 */}
                {error && !isLocked && (
                  <div className="rounded-lg p-3 text-sm bg-orange-500/10 border border-orange-500/50 text-orange-400">
                    <p className="font-medium">{error}</p>
                  </div>
                )}

                {isLocked && (
                  <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 text-red-400 flex items-start gap-3">
                    <Shield className="h-5 w-5 mt-0.5 shrink-0 animate-pulse" />
                    <div className="flex-1">
                      <p className="font-semibold mb-1">账户已锁定</p>
                      <p className="text-sm flex items-center gap-1.5">
                        <Clock className="h-4 w-4" />
                        剩余时间：<span className="font-mono font-semibold">{getRemainingTime()}</span>
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !password || isLocked}
              className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-medium rounded-lg hover:from-blue-700 hover:to-purple-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg"
            >
              {isLocked ? "账户已锁定" : loading ? "登录中..." : "登录"}
            </button>
          </form>
        </div>

        {/* 底部提示 */}
        <p className="text-center text-slate-500 text-sm mt-6">
          © 2025 CLIProxyAPI Monitor
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-900" />}>
      <LoginPageContent />
    </Suspense>
  );
}
