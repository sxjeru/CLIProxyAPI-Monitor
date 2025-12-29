CREATE TABLE IF NOT EXISTS "model_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"input_price_per_1k" numeric(10, 4) NOT NULL,
	"output_price_per_1k" numeric(10, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_model_unique" UNIQUE("model")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"route" text NOT NULL,
	"model" text NOT NULL,
	"total_tokens" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"total_requests" integer NOT NULL,
	"success_count" integer NOT NULL,
	"failure_count" integer NOT NULL,
	"is_error" boolean DEFAULT false NOT NULL,
	"raw" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_occurred_route_model_idx" ON "usage_records" USING btree ("occurred_at","route","model");