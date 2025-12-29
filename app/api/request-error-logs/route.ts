import { NextResponse } from "next/server";
import { config, assertEnv } from "@/lib/config";

export const runtime = "nodejs";

function listEndpoint() {
  return `${config.cliproxy.baseUrl.replace(/\/$/, "")}/request-error-logs`;
}

function fileEndpoint(name: string) {
  return `${config.cliproxy.baseUrl.replace(/\/$/, "")}/request-error-logs/${encodeURIComponent(name)}`;
}

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name");
  const url = name ? fileEndpoint(name) : listEndpoint();

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.cliproxy.apiKey}` }, cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: res.statusText }, { status: res.status });
    }

    if (name) {
      const text = await res.text();
      return new NextResponse(text, {
        status: 200,
        headers: { "Content-Type": res.headers.get("Content-Type") ?? "text/plain; charset=utf-8" }
      });
    }

    const data = await res.json();
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
