import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const password = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const realm = "CLIProxy Dashboard";
const COOKIE_NAME = "dashboard_auth";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
const cookieSecure = process.env.NODE_ENV === "production";
const expectedTokenPromise = password ? hashPassword(password) : null;

function decodeBasicToken(encoded: string) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(encoded, "base64").toString("utf8");
  }
  if (typeof atob === "function") {
    return atob(encoded);
  }
  throw new Error("No base64 decoder available");
}

function isBypassedPath(pathname: string) {
  if (pathname.startsWith("/_next")) return true;
  if (pathname.startsWith("/api/sync")) return true;
  if (pathname === "/favicon.ico") return true;
  if (pathname === "/cf-worker-sync.js") return true;
  return false;
}

function unauthorized() {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`
    }
  });
}

async function hashPassword(value: string) {
  const data = new TextEncoder().encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validateHeader(request: NextRequest, expectedToken: string | null) {
  if (!password) return { ok: true, token: null };
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Basic ")) return { ok: false, token: null };
  try {
    const decoded = decodeBasicToken(header.slice(6));
    const [, providedPassword] = decoded.split(":");
    const providedToken = await hashPassword(providedPassword ?? "");
    return { ok: providedToken === expectedToken, token: providedToken };
  } catch {
    return { ok: false, token: null };
  }
}

async function validateCookie(request: NextRequest, expectedToken: string | null) {
  if (!password) return { ok: true, token: null };
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return { ok: false, token: null };
  return { ok: token === expectedToken, token };
}

function withSessionCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    maxAge: COOKIE_MAX_AGE,
    path: "/"
  });
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isBypassedPath(pathname)) return NextResponse.next();
  
  // 允许访问登录页面和认证 API
  if (pathname === "/login" || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }
  
  if (!password) return NextResponse.next();

  const expectedToken = expectedTokenPromise ? await expectedTokenPromise : null;

  const cookieResult = await validateCookie(request, expectedToken);
  if (cookieResult.ok && cookieResult.token) {
    const res = NextResponse.next();
    return withSessionCookie(res, cookieResult.token); // refresh sliding window
  }

  const headerResult = await validateHeader(request, expectedToken);
  if (headerResult.ok && headerResult.token) {
    const res = NextResponse.next();
    return withSessionCookie(res, headerResult.token);
  }

  // 重定向到登录页面而不是返回 401
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: "/:path*"
};