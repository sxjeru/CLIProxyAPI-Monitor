import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const PASSWORD = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const COOKIE_NAME = "dashboard_auth";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

// 速率限制配置
const ATTEMPTS_PER_WINDOW = 10; // 每个时间窗口允许的尝试次数
const INITIAL_LOCKOUT_MS = 30 * 60 * 1000; // 初始锁定时间：30 分钟

// 存储失败记录 { ip: { totalAttempts: number, lockoutUntil: number, lockoutDuration: number } }
const failedAttempts = new Map<string, { totalAttempts: number; lockoutUntil: number; lockoutDuration: number }>();

// 清理过期记录（1小时后清理）
function cleanupExpired() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  for (const [ip, record] of failedAttempts.entries()) {
    if (record.lockoutUntil > 0 && now - record.lockoutUntil > oneHour) {
      failedAttempts.delete(ip);
    }
  }
}

function getClientIP(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

async function hashPassword(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBasicToken(encoded: string) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  if (typeof atob === "function") {
    return atob(encoded);
  }
  throw new Error("No base64 decoder available");
}

export async function POST(request: NextRequest) {
  cleanupExpired();

  if (!PASSWORD) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

  const clientIP = getClientIP(request);
  const now = Date.now();
  let record = failedAttempts.get(clientIP);

  // 检查是否在锁定期
  if (record && record.lockoutUntil > now) {
    const remainingSeconds = Math.ceil((record.lockoutUntil - now) / 1000);
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    const timeStr = minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
    
    return NextResponse.json(
      { 
        error: `账户已锁定，请 ${timeStr} 后再试`,
        lockoutUntil: record.lockoutUntil,
        isLocked: true
      },
      { status: 429 }
    );
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return NextResponse.json({ error: "Missing authorization" }, { status: 401 });
  }

  try {
    const decoded = decodeBasicToken(authHeader.slice(6));
    const [, providedPassword] = decoded.split(":");
    const providedToken = await hashPassword(providedPassword ?? "");
    const expectedToken = await hashPassword(PASSWORD);

    if (providedToken === expectedToken) {
      // 登录成功，清除失败记录
      failedAttempts.delete(clientIP);
      
      const response = NextResponse.json({ success: true });
      response.cookies.set({
        name: COOKIE_NAME,
        value: providedToken,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: COOKIE_MAX_AGE,
        path: "/"
      });
      return response;
    } else {
      // 登录失败，记录尝试
      if (!record) {
        record = { 
          totalAttempts: 0, 
          lockoutUntil: 0, 
          lockoutDuration: INITIAL_LOCKOUT_MS 
        };
      }
      
      record.totalAttempts++;
      
      // 每 10 次失败触发一次锁定
      if (record.totalAttempts % ATTEMPTS_PER_WINDOW === 0) {
        record.lockoutUntil = now + record.lockoutDuration;
        const lockoutMinutes = Math.ceil(record.lockoutDuration / 60000);
        
        failedAttempts.set(clientIP, record);
        
        // 下次锁定时间翻倍
        record.lockoutDuration *= 2;
        
        return NextResponse.json(
          {
            error: `连续错误 ${ATTEMPTS_PER_WINDOW} 次，账户已锁定 ${lockoutMinutes} 分钟`,
            lockoutUntil: record.lockoutUntil,
            isLocked: true,
            totalAttempts: record.totalAttempts
          },
          { status: 429 }
        );
      }
      
      failedAttempts.set(clientIP, record);
      
      const attemptsUntilLockout = ATTEMPTS_PER_WINDOW - (record.totalAttempts % ATTEMPTS_PER_WINDOW);
      
      return NextResponse.json(
        {
          error: "密码错误",
          remainingAttempts: attemptsUntilLockout,
          totalAttempts: record.totalAttempts,
          message: "密码错误"
        },
        { status: 401 }
      );
    }
  } catch (error) {
    return NextResponse.json({ error: "Invalid credentials format" }, { status: 400 });
  }
}
