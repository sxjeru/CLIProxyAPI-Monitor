ALTER TABLE "usage_records"
  ADD COLUMN "auth_index" text;

-- 回填历史数据中的 auth_index（从 raw.detail.auth_index 提取）
UPDATE "usage_records"
SET "auth_index" = NULLIF(("raw"::jsonb -> 'detail' ->> 'auth_index'), '')
WHERE "auth_index" IS NULL;
