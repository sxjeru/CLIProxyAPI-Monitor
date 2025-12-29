import { NextResponse } from "next/server";
import { config, assertEnv } from "@/lib/config";

export const runtime = "nodejs";

function endpoint(after?: string | null) {
  const base = `${config.cliproxy.baseUrl.replace(/\/$/, "")}/logs`;
  if (!after) return base;
  const url = new URL(base);
  url.searchParams.set("after", after);
  return url.toString();
}

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const after = searchParams.get("after");
    const res = await fetch(endpoint(after), {
      headers: { Authorization: `Bearer ${config.cliproxy.apiKey}` },
      cache: "no-store"
    });

    if (!res.ok) {
      return NextResponse.json({ error: res.statusText }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
