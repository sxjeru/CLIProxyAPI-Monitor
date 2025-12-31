import { NextResponse } from "next/server";

export const runtime = "nodejs";

function buildManagementUrl() {
  const raw = process.env.CLIPROXY_API_BASE_URL || "";
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const root = withProtocol.replace(/\/v0\/management\/?$/i, "").replace(/\/$/, "");
  if (!root) return null;
  return `${root}/management.html`;
}

export async function GET() {
  const url = buildManagementUrl();
  if (!url) {
    return NextResponse.json({ error: "CLIPROXY_API_BASE_URL is missing" }, { status: 501 });
  }
  return NextResponse.json({ url });
}
