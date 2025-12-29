import { NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { modelPrices } from "@/lib/db/schema";

type ModelPriceRow = typeof modelPrices.$inferSelect;

const priceSchema = z.object({
  model: z.string().min(1),
  inputPricePer1M: z.number().nonnegative(),
  cachedInputPricePer1M: z.number().nonnegative().optional().default(0),
  outputPricePer1M: z.number().nonnegative()
});

export const runtime = "nodejs";

function ensureDbEnv() {
  if (!config.postgresUrl) {
    throw new Error("DATABASE_URL is missing");
  }
}

export async function GET() {
  try {
    ensureDbEnv();
    const rows = await db.select().from(modelPrices).orderBy(modelPrices.model);
    const normalized = rows.map((row: ModelPriceRow) => ({
      model: row.model,
      inputPricePer1M: Number(row.inputPricePer1M),
      cachedInputPricePer1M: Number(row.cachedInputPricePer1M),
      outputPricePer1M: Number(row.outputPricePer1M)
    }));
    return NextResponse.json(normalized, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    ensureDbEnv();
    const body = await request.json();
    const parsed = priceSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }

    const data = parsed.data;
    await db
      .insert(modelPrices)
      .values({
        model: data.model,
        inputPricePer1M: String(data.inputPricePer1M),
        cachedInputPricePer1M: String(data.cachedInputPricePer1M ?? 0),
        outputPricePer1M: String(data.outputPricePer1M)
      })
      .onConflictDoUpdate({
        target: modelPrices.model,
        set: {
          inputPricePer1M: String(data.inputPricePer1M),
          cachedInputPricePer1M: String(data.cachedInputPricePer1M ?? 0),
          outputPricePer1M: String(data.outputPricePer1M)
        }
      });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

import { eq } from "drizzle-orm";

const deleteSchema = z.object({
  model: z.string().min(1)
});

export async function DELETE(request: Request) {
  try {
    ensureDbEnv();
    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
    }

    await db.delete(modelPrices).where(eq(modelPrices.model, parsed.data.model));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
