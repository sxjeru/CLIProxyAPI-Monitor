function normalizeBaseUrl(raw: string | undefined) {
  const value = (raw || "").trim();
  if (!value) return "";
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const trimmed = withProtocol.replace(/\/$/, "");
  return trimmed.endsWith("/v0/management") ? trimmed : `${trimmed}/v0/management`;
}

const baseUrl = normalizeBaseUrl(process.env.CLIPROXY_API_BASE_URL);
const password = process.env.PASSWORD || process.env.CLIPROXY_SECRET_KEY || "";
const cronSecret = process.env.CRON_SECRET || "";

function normalizeTimezone(raw: string | undefined): string {
  const value = (raw || "").trim();
  if (!value) return "Asia/Shanghai";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    console.warn(`TIMEZONE env var "${value}" is not a valid IANA timezone. Falling back to Asia/Shanghai.`);
    return "Asia/Shanghai";
  }
}

const timezone = normalizeTimezone(process.env.TIMEZONE);

export const config = {
  cliproxy: {
    baseUrl,
    apiKey: process.env.CLIPROXY_SECRET_KEY || ""
  },
  postgresUrl: process.env.DATABASE_URL || "",
  password,
  cronSecret,
  timezone
};

export function assertEnv() {
  if (!config.cliproxy.apiKey) {
    throw new Error("CLIPROXY_SECRET_KEY is missing");
  }
  if (!config.cliproxy.baseUrl) {
    throw new Error("CLIPROXY_API_BASE_URL is missing");
  }
  if (!config.postgresUrl) {
    throw new Error("DATABASE_URL is missing");
  }
}
