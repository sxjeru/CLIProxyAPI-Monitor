import { timingSafeEqual } from 'crypto';
import { createServer } from 'http';
import Redis from 'ioredis';

/**
 * CPA Metrics Adapter
 * 
 * 一个轻量级的中间件，用于从 CPA 的 Redis 队列中拉取使用数据，
 * 并将其重新聚合成兼容本项目（或其他工具）的 HTTP /usage 格式。
 * 
 * 运行方式: node adapter.js
 */

const CONFIG = {
  // CPA 管理端口的 Redis 地址
  redis: {
    host: process.env.CPA_REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.CPA_REDIS_PORT || '8317'),
    password: process.env.CPA_SECRET_KEY || '', // 对应 remote-management.secret-key
    key: process.env.CPA_REDIS_KEY || 'queue',
  },
  // 本适配器监听的端口
  port: parseInt(process.env.ADAPTER_PORT || '36871'),
  // usage 接口访问令牌：默认沿用 CPA_SECRET_KEY
  usageApiToken: (process.env.CPA_SECRET_KEY || '').trim(),
  // usage 接口鉴权失败限制
  auth: {
    maxAttempts: parseInt(process.env.USAGE_AUTH_MAX_ATTEMPTS || '10'),
    lockoutMs: parseInt(process.env.USAGE_AUTH_LOCKOUT_MS || '1800000'),
    cleanupMs: parseInt(process.env.USAGE_AUTH_CLEANUP_MS || '3600000'),
  },
  // 轮询间隔 (毫秒)
  pollInterval: parseInt(process.env.POLL_INTERVAL || '15000'),
  // 内存中保留的最大记录数
  maxBufferSize: parseInt(process.env.MAX_BUFFER_SIZE || '50000'),
  // 每次拉取的最大记录数
  batchSize: parseInt(process.env.BATCH_SIZE || '500'),
  // Redis 断连后的重连间隔
  reconnectInterval: parseInt(process.env.REDIS_RECONNECT_INTERVAL || '5000'),
  // 诊断 Redis 队列记录；默认关闭，避免日志泄露敏感信息
  debugUsageRecords: (process.env.DEBUG_USAGE_RECORDS || 'false').toLowerCase() === 'true',
  debugRawUsageRecords: (process.env.DEBUG_RAW_USAGE_RECORDS || 'false').toLowerCase() === 'true',
  // 访问 /usage 后是否清空内存缓冲区；true=增量导出，false=保留全量内存快照
  clearBufferOnRead: (process.env.CLEAR_BUFFER_ON_READ || 'false').toLowerCase() === 'true',
  // 远端 dashboard sync 配置
  sync: {
    enabled: (process.env.ENABLE_PERIODIC_SYNC || 'false').toLowerCase() === 'true',
    dashboardUrl: (process.env.DASHBOARD_URL || '').trim().replace(/\/$/, ''),
    token: (process.env.SYNC_TOKEN || process.env.CPA_SECRET_KEY || '').trim(),
    interval: parseInt(process.env.SYNC_INTERVAL || '6000000'), // 默认同步间隔 100 分钟
    timeoutMs: parseInt(process.env.SYNC_TIMEOUT_MS || '300000'),
    syncOnStart: (process.env.SYNC_ON_START || 'false').toLowerCase() === 'true',
  },
};

// 内存缓冲区，用于存放最近拉取的记录
let usageBuffer = [];
let syncInProgress = false;
let adapterStarted = false;
let redisReconnectTimer = null;
const failedAuthAttempts = new Map();

// 初始化 Redis 客户端
const redis = new Redis({
  host: CONFIG.redis.host,
  port: CONFIG.redis.port,
  password: CONFIG.redis.password,
  lazyConnect: true,
  enableReadyCheck: false,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on('error', (error) => {
  if (!adapterStarted) return;
  console.error('[redis] Connection error:', error.message);
  scheduleRedisReconnect();
});

redis.on('ready', () => {
  stopRedisReconnect();
});

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isUsageAuthorized(req) {
  const expectedToken = CONFIG.usageApiToken;
  if (!expectedToken) return true;

  const authorization = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    return false;
  }

  const providedToken = authorization.slice(prefix.length).trim();
  if (!providedToken) {
    return false;
  }

  return safeEqualText(providedToken, expectedToken);
}

function getRequestPath(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return req.url || '/';
  }
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;

  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : 'unknown';
  const apiKey = typeof record.api_key === 'string' && record.api_key.trim() ? record.api_key.trim() : '';
  const authType = typeof record.auth_type === 'string' && record.auth_type.trim() ? record.auth_type.trim() : '';
  const endpoint = apiKey || authType || (typeof record.endpoint === 'string' && record.endpoint.trim() ? record.endpoint.trim() : 'default');
  const source = typeof record.source === 'string' ? record.source : '';
  const timestamp = typeof record.timestamp === 'string' && record.timestamp.trim()
    ? record.timestamp
    : new Date().toISOString();
  const auth_index = record.auth_index == null ? null : String(record.auth_index).trim() || null;
  const failed = Boolean(record.failed);
  const tokens = record.tokens && typeof record.tokens === 'object' ? record.tokens : {};

  const input = Number(tokens.input_tokens || 0);
  const output = Number(tokens.output_tokens || 0);
  const cached = Number(tokens.cached_tokens || 0);
  const reasoning = Number(tokens.reasoning_tokens || 0);
  const total = Number(tokens.total_tokens || (input + output + reasoning));

  return {
    ...record,
    model,
    endpoint,
    source,
    timestamp,
    auth_index,
    failed,
    tokens: {
      ...tokens,
      input_tokens: Number.isFinite(input) ? input : 0,
      output_tokens: Number.isFinite(output) ? output : 0,
      cached_tokens: Number.isFinite(cached) ? cached : 0,
      reasoning_tokens: Number.isFinite(reasoning) ? reasoning : 0,
      total_tokens: Number.isFinite(total) ? total : 0,
    }
  };
}

function redactUsageRecord(record) {
  if (!record || typeof record !== 'object') return record;

  // Never put the raw api_key into the returned object (CodeQL taint + log safety).
  // endpoint may equal api_key after normalizeRecord; redact both when present.
  const { api_key: _apiKey, endpoint, ...rest } = record;
  const hasApiKey = Boolean(_apiKey);
  return {
    ...rest,
    api_key: hasApiKey ? '[redacted]' : undefined,
    endpoint: hasApiKey ? '[redacted]' : endpoint,
  };
}

function redactRawUsageRecord(rawRecord) {
  if (typeof rawRecord !== 'string') return '[redacted-raw]';
  try {
    return redactUsageRecord(JSON.parse(rawRecord));
  } catch {
    // Unparseable payload may still contain secrets; never log clear text.
    return '[redacted-raw]';
  }
}

function getRecordTokenTotal(record) {
  const tokens = record && typeof record === 'object' && record.tokens && typeof record.tokens === 'object'
    ? record.tokens
    : {};
  const input = Number(tokens.input_tokens || 0);
  const output = Number(tokens.output_tokens || 0);
  const cached = Number(tokens.cached_tokens || 0);
  const reasoning = Number(tokens.reasoning_tokens || 0);
  const total = Number(tokens.total_tokens || (input + output + reasoning));

  return Number.isFinite(total) ? total : 0;
}

function logUsageRecordDiagnostic(record, rawRecord) {
  if (!CONFIG.debugUsageRecords && !CONFIG.debugRawUsageRecords) return;

  const tokenTotal = getRecordTokenTotal(record);
  // Construct summary without ever assigning the raw api_key value into it.
  const hasApiKey = Boolean(record.api_key);
  const summary = {
    timestamp: record.timestamp,
    endpoint: hasApiKey ? '[redacted]' : record.endpoint,
    auth_type: record.auth_type,
    api_key: hasApiKey ? '[redacted]' : undefined,
    provider: record.provider,
    model: record.model,
    alias: record.alias,
    source: record.source,
    auth_index: record.auth_index,
    request_id: record.request_id,
    failed: record.failed,
    tokenTotal,
    tokens: record.tokens,
  };

  if (CONFIG.debugUsageRecords || tokenTotal === 0) {
    console.log('[usage-debug] queue record summary:', summary);
  }

  if (CONFIG.debugRawUsageRecords) {
    console.log('[usage-debug] queue record raw:', redactRawUsageRecord(rawRecord));
  }
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getReconnectInterval() {
  return toPositiveInt(CONFIG.reconnectInterval, 5000);
}

async function ensureRedisConnected() {
  if (redis.status === 'ready') return true;
  if (redis.status === 'connecting' || redis.status === 'reconnecting') return false;

  try {
    await redis.connect();
    return redis.status === 'ready';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[redis] Reconnect failed:', message);
    return false;
  }
}

function stopRedisReconnect() {
  if (!redisReconnectTimer) return;
  clearInterval(redisReconnectTimer);
  redisReconnectTimer = null;
  console.log('[redis] Reconnected');
}

function scheduleRedisReconnect() {
  if (redisReconnectTimer) return;

  const reconnectInterval = getReconnectInterval();
  console.warn(`[redis] Start reconnect loop, interval=${reconnectInterval}ms`);

  redisReconnectTimer = setInterval(() => {
    void ensureRedisConnected();
  }, reconnectInterval);

  void ensureRedisConnected();
}

function getAuthConfig() {
  return {
    maxAttempts: toPositiveInt(CONFIG.auth.maxAttempts, 10),
    lockoutMs: toPositiveInt(CONFIG.auth.lockoutMs, 30 * 60 * 1000),
    cleanupMs: toPositiveInt(CONFIG.auth.cleanupMs, 60 * 60 * 1000),
  };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function cleanupExpiredAuthFailures(now = Date.now()) {
  const { cleanupMs } = getAuthConfig();

  for (const [ip, record] of failedAuthAttempts.entries()) {
    if (record.lockedUntil > 0 && now - record.lockedUntil > cleanupMs) {
      failedAuthAttempts.delete(ip);
    }
  }
}

function getLockoutState(req) {
  const now = Date.now();
  cleanupExpiredAuthFailures(now);

  const ip = getClientIp(req);
  const record = failedAuthAttempts.get(ip);
  if (!record || record.lockedUntil <= now) {
    return { ip, locked: false, remainingMs: 0 };
  }

  return {
    ip,
    locked: true,
    remainingMs: Math.max(record.lockedUntil - now, 0),
  };
}

function clearAuthFailures(ip) {
  failedAuthAttempts.delete(ip);
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const { maxAttempts, lockoutMs } = getAuthConfig();
  const existing = failedAuthAttempts.get(ip) || { attempts: 0, lockedUntil: 0 };
  const attempts = existing.attempts + 1;

  if (attempts >= maxAttempts) {
    const next = { attempts: 0, lockedUntil: now + lockoutMs };
    failedAuthAttempts.set(ip, next);
    return { locked: true, remainingAttempts: 0, retryAfterMs: lockoutMs };
  }

  failedAuthAttempts.set(ip, { attempts, lockedUntil: 0 });
  return {
    locked: false,
    remainingAttempts: Math.max(maxAttempts - attempts, 0),
    retryAfterMs: 0,
  };
}

function getSyncConfig() {
  const interval = toPositiveInt(CONFIG.sync.interval, 60000);
  const timeoutMs = toPositiveInt(CONFIG.sync.timeoutMs, 30000);

  return {
    ...CONFIG.sync,
    interval,
    timeoutMs,
  };
}

function getSyncUrl() {
  const { dashboardUrl } = getSyncConfig();
  if (!dashboardUrl) return '';

  try {
    const url = new URL('/api/sync', `${dashboardUrl}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * 从 Redis 拉取并聚合数据
 */
async function drainQueue() {
  try {
    if (!(await ensureRedisConnected())) {
      return;
    }

    // 使用 LPOP count 拉取数据
    const rawData = await redis.lpop(CONFIG.redis.key, CONFIG.batchSize);

    if (!rawData) return;

    const records = Array.isArray(rawData) ? rawData : [rawData];
    const parsedRecords = [];

    for (const rawRecord of records) {
      try {
        const parsed = JSON.parse(rawRecord);
        const normalized = normalizeRecord(parsed);
        if (!normalized) {
          console.error('Skipped invalid record:', redactRawUsageRecord(rawRecord));
          continue;
        }
        logUsageRecordDiagnostic(normalized, rawRecord);
        parsedRecords.push(normalized);
      } catch (e) {
        console.error('Failed to parse record:', redactRawUsageRecord(rawRecord));
      }
    }

    if (parsedRecords.length > 0) {
      usageBuffer.push(...parsedRecords);
      // 保持缓冲区大小
      if (usageBuffer.length > CONFIG.maxBufferSize) {
        usageBuffer = usageBuffer.slice(-CONFIG.maxBufferSize);
      }
      console.log(`[${new Date().toISOString()}] Drained ${parsedRecords.length} records. Buffer: ${usageBuffer.length}`);
    }
  } catch (err) {
    console.error('Drain error:', err.message);
  }
}

async function verifyRedisConnection() {
  try {
    if (await ensureRedisConnected()) return;
    throw new Error(`Redis not ready, current status: ${redis.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error('[startup] Failed to connect to CPA Redis usage queue');
    console.error(`[startup] Target: ${CONFIG.redis.host}:${CONFIG.redis.port}`);
    console.error(`[startup] Key: ${CONFIG.redis.key}`);
    console.error(`[startup] Reason: ${message}`);
    console.error('[startup] Check whether Management is enabled, usage-statistics-enabled is true, and CPA_SECRET_KEY/port are correct.');

    throw error;
  }
}

async function triggerSync(reason = 'interval') {
  const syncConfig = getSyncConfig();

  if (!syncConfig.enabled) return;

  const syncUrl = getSyncUrl();
  if (!syncUrl) {
    console.error('[sync] Invalid or missing DASHBOARD_URL');
    return;
  }

  if (!syncConfig.token) {
    console.error('[sync] Missing SYNC_TOKEN/CRON_SECRET/PASSWORD');
    return;
  }

  if (syncInProgress) {
    console.warn('[sync] Previous sync still in progress, skipped');
    return;
  }

  syncInProgress = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), syncConfig.timeoutMs);

  try {
    const response = await fetch(syncUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${syncConfig.token}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[sync] Trigger failed (${reason}): ${response.status} ${response.statusText}`);
      return;
    }

    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    console.log(`[sync] Triggered (${reason})`, result || { status: response.status });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    console.error(`[sync] Trigger error (${reason}): ${isTimeout ? 'timeout' : error.message}`);
  } finally {
    clearTimeout(timeoutId);
    syncInProgress = false;
  }
}

const syncConfig = getSyncConfig();

async function startAdapter() {
  await verifyRedisConnection();

  adapterStarted = true;

  // 定时任务
  setInterval(drainQueue, CONFIG.pollInterval);
  await drainQueue();

  if (syncConfig.enabled) {
    setInterval(() => {
      triggerSync('interval');
    }, syncConfig.interval);

    if (syncConfig.syncOnStart) {
      void triggerSync('startup');
    }
  }

  server.listen(CONFIG.port, () => {
    console.log(`Adapter running at http://localhost:${CONFIG.port}`);
    console.log(`Polling CPA Redis at ${CONFIG.redis.host}:${CONFIG.redis.port}`);
    console.log(`Redis queue key: ${CONFIG.redis.key}`);
    console.log(`Clear buffer on read: ${CONFIG.clearBufferOnRead}`);
    console.log(`Usage debug records: ${CONFIG.debugUsageRecords}`);
    console.log(`Usage debug raw records: ${CONFIG.debugRawUsageRecords}`);
    console.log(`Usage API auth enabled: ${Boolean(CONFIG.usageApiToken)}`);
    if (CONFIG.usageApiToken) {
      const authConfig = getAuthConfig();
      console.log(`Usage API max auth attempts: ${authConfig.maxAttempts}`);
      console.log(`Usage API lockout ms: ${authConfig.lockoutMs}`);
    }

    const syncUrl = getSyncUrl();
    console.log(`Periodic sync enabled: ${syncConfig.enabled}`);
    if (syncConfig.enabled) {
      console.log(`Periodic sync target: ${syncUrl || 'invalid DASHBOARD_URL'}`);
      console.log(`Periodic sync interval: ${syncConfig.interval}ms`);
      console.log(`Periodic sync on start: ${syncConfig.syncOnStart}`);
    }
  });
}

/**
 * 将内存缓冲区的数据转换为旧版 /usage 聚合格式
 */
function getAggregatedUsage() {
  const result = {
    usage: {
      total_tokens: 0,
      apis: {}
    },
    meta: {
      buffer_size: usageBuffer.length,
      clear_on_read: CONFIG.clearBufferOnRead,
    }
  };

  for (const record of usageBuffer) {
    const { model, endpoint, tokens, timestamp, source, auth_index, failed } = record;
    const route = endpoint || 'default';
    const t = tokens || {};
    
    const input = t.input_tokens || 0;
    const output = t.output_tokens || 0;
    const cached = t.cached_tokens || 0;
    const reasoning = t.reasoning_tokens || 0;
    const total = t.total_tokens || (input + output + reasoning);

    result.usage.total_tokens += total;

    if (!result.usage.apis[route]) {
      result.usage.apis[route] = { total_tokens: 0, models: {} };
    }

    const api = result.usage.apis[route];
    api.total_tokens += total;

    if (!api.models[model]) {
      api.models[model] = {
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        details: []
      };
    }

    const m = api.models[model];
    m.total_tokens += total;
    m.input_tokens += input;
    m.output_tokens += output;
    m.cached_tokens += cached;
    m.reasoning_tokens += reasoning;
    
    m.details.push({
      timestamp,
      source,
      auth_index,
      tokens: t,
      failed: !!failed
    });
  }

  return result;
}

// 创建 HTTP 服务
const server = createServer((req, res) => {
  const pathname = getRequestPath(req);

  if (pathname === '/usage' || pathname === '/v0/management/usage') {
    const lockoutState = getLockoutState(req);
    if (lockoutState.locked) {
      const retryAfterSeconds = Math.max(Math.ceil(lockoutState.remainingMs / 1000), 1);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
      });
      res.end(JSON.stringify({ error: 'Too many unauthorized attempts' }));
      return;
    }

    if (!isUsageAuthorized(req)) {
      const failure = recordAuthFailure(lockoutState.ip);
      const headers = {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="cpa-adapter-usage"',
      };

      if (failure.locked) {
        headers['Retry-After'] = String(Math.max(Math.ceil(failure.retryAfterMs / 1000), 1));
      }

      res.writeHead(failure.locked ? 429 : 401, headers);
      res.end(JSON.stringify({
        error: failure.locked ? 'Too many unauthorized attempts' : 'Unauthorized',
        remainingAttempts: failure.locked ? 0 : failure.remainingAttempts,
      }));
      return;
    }

    clearAuthFailures(lockoutState.ip);

    const data = getAggregatedUsage();
    
    if (CONFIG.clearBufferOnRead) {
      usageBuffer = [];
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } else {
    res.writeHead(404);
    res.end();
  }
});

startAdapter().catch(() => {
  process.exitCode = 1;
});
