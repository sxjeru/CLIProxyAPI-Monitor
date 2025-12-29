import { NextResponse } from "next/server";
import { assertEnv } from "@/lib/config";
import { getOverview } from "@/lib/queries/overview";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    assertEnv();
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 501 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days");
    const days = daysParam ? Number.parseInt(daysParam, 10) : undefined;
    const model = searchParams.get("model");
    const route = searchParams.get("route");
    const pageParam = searchParams.get("page");
    const pageSizeParam = searchParams.get("pageSize");

    const { overview, empty, days: appliedDays, meta, filters } = await getOverview(days, {
      model: model || undefined,
      route: route || undefined,
      page: pageParam ? Number.parseInt(pageParam, 10) : undefined,
      pageSize: pageSizeParam ? Number.parseInt(pageSizeParam, 10) : undefined
    });

    return NextResponse.json({ overview, empty, days: appliedDays, meta, filters }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
