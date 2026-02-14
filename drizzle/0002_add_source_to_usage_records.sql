ALTER TABLE "usage_records"
  ADD COLUMN "source" text NOT NULL DEFAULT '';

-- 回填历史数据中的 source（从 raw.detail.source 提取）
UPDATE "usage_records"
SET "source" = COALESCE(NULLIF(("raw"::jsonb -> 'detail' ->> 'source'), ''), '')
WHERE "source" = '';

DROP INDEX IF EXISTS "usage_records_occurred_route_model_idx";

CREATE UNIQUE INDEX "usage_records_occurred_route_model_source_idx"
  ON "usage_records" USING btree ("occurred_at", "route", "model", "source");
