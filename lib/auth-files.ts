import { z } from "zod";
import { authFileMappings } from "@/lib/db/schema";

export type AuthFileMappingInsert = typeof authFileMappings.$inferInsert;

const authFileItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    auth_index: z.union([z.string(), z.number()]).optional(),
    authIndex: z.union([z.string(), z.number()]).optional(),
    index: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    provider: z.string().optional(),
    source: z.string().optional(),
    email: z.string().optional(),
    updated_at: z.string().optional(),
    updatedAt: z.string().optional()
  })
  .passthrough();

function toTrimmedString(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function toDateOrNull(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function pickArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const obj = payload as Record<string, unknown>;
  const directKeys = ["files", "auth_files", "authFiles", "items", "list", "records"];

  for (const key of directKeys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }

  const nestedKeys = ["data", "result", "payload"];
  for (const nestedKey of nestedKeys) {
    const nested = obj[nestedKey];
    if (Array.isArray(nested)) return nested;
    if (!nested || typeof nested !== "object") continue;
    const nestedObj = nested as Record<string, unknown>;

    for (const key of directKeys) {
      const value = nestedObj[key];
      if (Array.isArray(value)) return value;
    }
  }

  return [];
}

export function toAuthFileMappings(payload: unknown, pulledAt: Date = new Date()): AuthFileMappingInsert[] {
  const arr = pickArray(payload);
  if (arr.length === 0) return [];

  const dedup = new Map<string, AuthFileMappingInsert>();

  for (const item of arr) {
    const parsed = authFileItemSchema.safeParse(item);
    if (!parsed.success) continue;

    const name = toTrimmedString(parsed.data.name);
    const explicitAuthIndex = parsed.data.auth_index ?? parsed.data.authIndex ?? parsed.data.index;
    const authId = toTrimmedString(explicitAuthIndex ?? parsed.data.id);
    if (!authId) continue;

    // 某些返回中 id 可能与 name 同值但并非 usage 里的 auth_index，避免误写入错误映射主键。
    if (explicitAuthIndex === undefined && name && authId === name) continue;

    const updatedAt = toDateOrNull(parsed.data.updated_at ?? parsed.data.updatedAt);

    const existing = dedup.get(authId);

    // Only replace an existing entry when:
    // - there is no existing entry, or
    // - the new record has an updatedAt and the existing one is null, or
    // - both have updatedAt and the new one is more recent.
    if (
      !existing ||
      (updatedAt &&
        (!existing.updatedAt || updatedAt > existing.updatedAt))
    ) {
      dedup.set(authId, {
        authId,
        name: toTrimmedString(parsed.data.name),
        label: toTrimmedString(parsed.data.label) || null,
        provider: toTrimmedString(parsed.data.provider) || null,
        source: toTrimmedString(parsed.data.source) || null,
        email: toTrimmedString(parsed.data.email) || null,
        updatedAt,
        syncedAt: pulledAt
      });
    }
  }

  return Array.from(dedup.values());
}
