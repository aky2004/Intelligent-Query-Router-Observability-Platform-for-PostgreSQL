require('dotenv').config();

const routerUrl = (process.env.PG_ROUTER_URL || process.env.POOLER_URL || 'http://localhost:3000').replace(/\/$/, '');
const routerToken = process.env.PG_ROUTER_TOKEN || process.env.POOLER_TOKEN || process.env.AUTH_TOKEN;
const queryCount = Number.parseInt(process.env.PROBE_QUERIES || '24', 10);
const concurrency = Number.parseInt(process.env.PROBE_CONCURRENCY || '2', 10);
const delayMs = Number.parseInt(process.env.PROBE_DELAY_MS || '200', 10);
const forcePrimary = process.env.PROBE_FORCE_PRIMARY === 'true';

// Diverse query shapes to simulate realistic application traffic and prevent false N+1 / volume-spike alerts
const QUERY_TEMPLATES = [
  () => ({
    name: 'heartbeat',
    sql: `SELECT 1 AS heartbeat, NOW() AS ping_time`,
    params: [],
  }),
  () => ({
    name: 'server_info',
    sql: `SELECT current_database() AS db, current_user AS "user", inet_server_port() AS port`,
    params: [],
  }),
  () => ({
    name: 'schema_stats',
    sql: `SELECT count(*) AS total_tables FROM information_schema.tables WHERE table_schema = 'information_schema'`,
    params: [],
  }),
  () => ({
    name: 'list_tables',
    sql: `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' LIMIT 5`,
    params: [],
  }),
  () => ({
    name: 'pg_settings_max_conn',
    sql: `SELECT name, setting, unit FROM pg_settings WHERE name = 'max_connections'`,
    params: [],
  }),
  () => ({
    name: 'pg_types',
    sql: `SELECT typname, typlen FROM pg_type WHERE typname IN ('int4', 'varchar', 'timestamp', 'bool')`,
    params: [],
  }),
  () => ({
    name: 'math_series',
    sql: `SELECT x, x * x AS squared FROM generate_series(1, 3) AS t(x)`,
    params: [],
  }),
  () => ({
    name: 'recovery_check',
    sql: `SELECT pg_is_in_recovery() AS is_replica`,
    params: [],
  }),
  () => ({
    name: 'pg_settings_buffers',
    sql: `SELECT name, setting, short_desc FROM pg_settings WHERE name = 'shared_buffers'`,
    params: [],
  }),
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runQuery = async (index) => {
  const templateFn = QUERY_TEMPLATES[index % QUERY_TEMPLATES.length];
  const query = templateFn();
  const startedAt = performance.now();
  const headers = { 'Content-Type': 'application/json' };
  if (routerToken) headers.Authorization = `Bearer ${routerToken}`;

  const response = await fetch(`${routerUrl}/api/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql: query.sql, params: query.params, forcePrimary }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const message = payload?.error?.message || payload?.error || payload?.message || response.statusText;
    throw new Error(`Query #${index + 1} (${query.name}) failed (${response.status}): ${message}`);
  }

  const durationMs = performance.now() - startedAt;
  return {
    index: index + 1,
    name: query.name,
    durationMs,
    decision: payload?.data?.decision || null,
    rowCount: payload?.data?.result?.rowCount ?? null,
  };
};

const runWorker = async (workerId, nextIndex) => {
  const results = [];
  while (true) {
    const index = nextIndex.value;
    nextIndex.value += 1;
    if (index >= queryCount) break;

    try {
      const res = await runQuery(index);
      results.push(res);
      // Pacing delay with gentle jitter to simulate realistic client request intervals
      if (delayMs > 0) {
        const jitter = Math.floor(Math.random() * (delayMs * 0.4)) - (delayMs * 0.2);
        await sleep(Math.max(20, delayMs + jitter));
      }
    } catch (err) {
      console.warn(`[traffic-probe] Worker ${workerId}: ${err.message}`);
    }
  }
  return { workerId, results };
};

const summarize = (durations) => {
  if (!durations.length) return { count: 0, minMs: 0, avgMs: 0, maxMs: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(2)),
    avgMs: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
};

const main = async () => {
  if (!Number.isInteger(queryCount) || queryCount < 1) throw new Error('PROBE_QUERIES must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('PROBE_CONCURRENCY must be a positive integer');

  console.log(`[traffic-probe] Pacing ${queryCount} queries across ${concurrency} worker(s) (delay ~${delayMs}ms) to ${routerUrl}/api/query...`);

  const nextIndex = { value: 0 };
  const startTime = performance.now();
  const workers = Array.from(
    { length: Math.min(concurrency, queryCount) },
    (_, workerId) => runWorker(workerId + 1, nextIndex),
  );
  const workerResults = await Promise.all(workers);
  const queries = workerResults.flatMap((worker) => worker.results);
  const totalElapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);

  const durations = queries.map((query) => query.durationMs);
  const queryTypes = queries.reduce((counts, query) => {
    counts[query.name] = (counts[query.name] || 0) + 1;
    return counts;
  }, {});
  const decisions = queries.reduce((counts, query) => {
    const target = query.decision?.target || 'unknown';
    counts[target] = (counts[target] || 0) + 1;
    return counts;
  }, {});

  console.log(JSON.stringify({
    target: {
      queryApi: `${routerUrl}/api/query`,
      forcePrimary,
      authenticated: Boolean(routerToken),
    },
    performance: {
      totalQueries: queries.length,
      totalElapsedSec: `${totalElapsedSec}s`,
      queriesPerSec: Number((queries.length / (totalElapsedSec || 1)).toFixed(2)),
      latency: summarize(durations),
    },
    routing: {
      decisions,
      queryDistribution: queryTypes,
    },
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(`[db:traffic] ${error.message}`);
    process.exitCode = 1;
  });
