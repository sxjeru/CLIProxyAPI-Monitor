CREATE TABLE "auth_file_mappings" (
  "auth_id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL DEFAULT '',
  "label" text,
  "provider" text,
  "source" text,
  "email" text,
  "updated_at" timestamp with time zone,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "auth_file_mappings_name_idx"
  ON "auth_file_mappings" USING btree ("name");
