import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { usageRecords } from "@/lib/db/schema";

export async function POST() {
  try {
    await db.delete(usageRecords);
    return NextResponse.json({ success: true, message: "usage_records 表已清空" });
  } catch (error) {
    console.error("Failed to reset usage_records:", error);
    return NextResponse.json(
      { success: false, error: "清空表失败" },
      { status: 500 }
    );
  }
}
