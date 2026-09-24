#!/usr/bin/env bun
/**
 * Ping-Pooler Test Data Seeder
 * ────────────────────────────
 * 1. Applies migrations/002_seed.sql to the Neon PostgreSQL database
 * 2. Fires a realistic burst of API calls at the running backend to populate
 *    in-memory metrics, query history, pool pressure, and anomaly alerts.
 *
 * Usage (backend must be running):
 *   bun scripts/seed.js
 *   BACKEND_URL=http://localhost:3000 bun scripts/seed.js
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Use backend's installed pg + dotenv (avoids installing extra deps at root)
const pg = require("../backend/node_modules/pg");
const dotenv = require("../backend/node_modules/dotenv");

// Load env from backend/.env
dotenv.config({ path: path.resolve(__dirname, "../backend/.env") });

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const DB_URL = process.env.PRIMARY_DATABASE_URL;

if (!DB_URL) {
  console.error("❌  PRIMARY_DATABASE_URL not set — check backend/.env");
  process.exit(1);
}

const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Step 1: Apply SQL seed ────────────────────────────────────────────────

async function applySeed() {
  console.log(bold("\n📦  Step 1 — Applying SQL seed to PostgreSQL…\n"));
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  const sqlPath = path.resolve(__dirname, "../backend/migrations/002_seed.sql");
  const sql = readFileSync(sqlPath, "utf8");

  try {
    await client.query(sql);
    console.log(green("  ✓ Seed SQL applied successfully"));
  } catch (err) {
    console.error(red(`  ✗ Seed SQL failed: ${err.message}`));
    console.log(yellow("  ⚠ Continuing — tables may already exist from a previous run"));
  } finally {
    await client.end();
  }
}

// ─── Step 2: Hit the backend API ──────────────────────────────────────────

const QUERIES = [
  // SELECTs → replicas
  "SELECT * FROM users WHERE tier = 'pro' LIMIT 25",
  "SELECT COUNT(*) FROM orders WHERE status = 'pending'",
  "SELECT u.full_name, COUNT(o.id) AS order_count FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.full_name ORDER BY 2 DESC LIMIT 20",
  "SELECT p.name, SUM(oi.quantity) AS units_sold FROM products p JOIN order_items oi ON oi.product_id = p.id GROUP BY p.id, p.name ORDER BY 2 DESC LIMIT 10",
  "SELECT * FROM orders WHERE placed_at > now() - interval '7 days' ORDER BY placed_at DESC LIMIT 50",
  "SELECT AVG(total_cents), MAX(total_cents), MIN(total_cents) FROM orders WHERE status = 'delivered'",
  "SELECT country, COUNT(*) AS cnt FROM users GROUP BY country ORDER BY 2 DESC",
  "SELECT * FROM products WHERE category = 'Cloud' AND is_available = true ORDER BY price_cents ASC",
  "SELECT o.*, u.email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'paid' LIMIT 30",
  "SELECT DATE_TRUNC('day', placed_at) AS day, COUNT(*), SUM(total_cents) FROM orders GROUP BY 1 ORDER BY 1 DESC LIMIT 30",
  "SELECT * FROM anomaly_log WHERE severity IN ('high','critical') ORDER BY detected_at DESC LIMIT 10",
  "SELECT id, email, tier FROM users WHERE is_active = true AND tier = 'enterprise' ORDER BY created_at DESC LIMIT 10",
  "SELECT node_id, AVG(pressure) AS avg_pressure FROM pool_snapshots WHERE snapshot_at > now() - interval '1 hour' GROUP BY node_id",
  "SELECT * FROM query_log WHERE status = 'error' ORDER BY executed_at DESC LIMIT 10",
  "SELECT category, COUNT(*) AS products, AVG(price_cents) AS avg_price FROM products GROUP BY category ORDER BY 2 DESC",
  // Transaction → primary
  "BEGIN",
  "SELECT * FROM users WHERE id = 1",
  "COMMIT",
];

const NL_QUERIES = [
  "Show me the top 10 users by number of orders",
  "What is the average order value in the last 30 days?",
  "List all products in the Security category",
  "How many orders are in pending status?",
  "Show users from the US who are on the pro tier",
  "Find the most expensive products ordered by price",
  "What is the total revenue from delivered orders?",
];

async function callApi(method, endpoint, body) {
  const url = `${BACKEND_URL}/api${endpoint}`;
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function warmMetrics() {
  console.log(bold(`\n🔥  Step 2 — Warming backend metrics at ${BACKEND_URL}…\n`));
  let pass = 0, fail = 0;

  // ── Dashboard GET endpoints ──────────────────────────────────────────────
  process.stdout.write(cyan("  Polling dashboard endpoints… "));
  const endpoints = ["/metrics/dashboard", "/nodes", "/pool/pressure", "/anomalies", "/queries/history?limit=50", "/settings"];
  for (const ep of endpoints) {
    const r = await callApi("GET", ep);
    r.ok ? pass++ : fail++;
    process.stdout.write(r.ok ? green(".") : red("x"));
    await sleep(100);
  }
  console.log();

  // ── Execute queries ──────────────────────────────────────────────────────
  console.log(cyan(`\n  Executing ${QUERIES.length} SQL queries against real DB…`));
  for (let i = 0; i < QUERIES.length; i++) {
    const r = await callApi("POST", "/query/execute", {
      sql: QUERIES[i],
      sessionId: `seed-session-${Math.floor(i / 4)}`,
      checkSafety: true,
    });
    if (r.ok) { pass++; process.stdout.write(green(".")); }
    else       { fail++; process.stdout.write(yellow("?")); }
    await sleep(80);
  }
  console.log();

  // ── 2 more bursts to build time-series ──────────────────────────────────
  console.log(cyan("\n  Building time-series data (15 queries × 2 bursts)…"));
  for (let burst = 0; burst < 2; burst++) {
    for (const sql of QUERIES.slice(0, 15)) {
      const r = await callApi("POST", "/query/execute", { sql, sessionId: `burst-${burst}` });
      process.stdout.write(r.ok ? green(".") : yellow("?"));
      if (r.ok) pass++; else fail++;
      await sleep(50);
    }
    console.log();
    await sleep(400);
  }

  // ── NL-to-SQL ─────────────────────────────────────────────────────────────
  console.log(cyan(`\n  Testing NL→SQL (${NL_QUERIES.length} questions via DeepSeek Bedrock)…`));
  for (const q of NL_QUERIES) {
    const r = await callApi("POST", "/ai/convert", { naturalLanguage: q });
    const sql = r.data?.data?.sql;
    if (r.ok && sql) {
      console.log(green(`    ✓ "${q.slice(0, 50)}"`));
      console.log(`      → ${sql.slice(0, 90)}`);
      pass++;
    } else {
      const msg = r.data?.error?.message ?? r.error ?? "no sql returned";
      console.log(yellow(`    ⚠ "${q.slice(0, 50)}" — ${msg}`));
      fail++;
    }
    await sleep(300);
  }

  // ── AI safety checks ────────────────────────────────────────────────────
  console.log(cyan("\n  Running AI safety checks (safe + dangerous)…"));
  const safetyTests = [
    "SELECT * FROM users LIMIT 10",
    "SELECT * FROM users WHERE id=1 OR 1=1",
    "DELETE FROM orders",
    "SELECT COUNT(*) FROM orders WHERE status='pending'",
    "SELECT id FROM users WHERE email=$1",
  ];
  for (const sql of safetyTests) {
    const r = await callApi("POST", "/ai/safety", { sql });
    if (r.ok) {
      const safe  = r.data?.data?.safety?.isSafe;
      const level = r.data?.data?.safety?.riskLevel ?? "?";
      console.log(`    ${safe ? green("✓ SAFE   ") : red("⚠ BLOCKED")}  [${level.padEnd(8)}]  ${sql.slice(0, 55)}`);
      pass++;
    } else {
      console.log(yellow(`    ⚠  Safety check failed: ${sql.slice(0, 55)}`));
      fail++;
    }
    await sleep(200);
  }

  // ── Final dashboard snapshot ─────────────────────────────────────────────
  console.log(cyan("\n  Final dashboard snapshot…"));
  const final = await callApi("GET", "/metrics/dashboard");
  if (final.ok) {
    const d = final.data?.data;
    if (d) {
      console.log(green("    ✓ Dashboard is live with real data"));
      console.log(`      Connections:   ${d.connections?.active ?? "?"}/${d.connections?.total ?? "?"} active`);
      console.log(`      QPS:           ${d.queriesPerSecond ?? "?"}`);
      console.log(`      Avg latency:   ${d.avgLatency ?? "?"}`);
      console.log(`      Error rate:    ${d.errorRate ?? "?"}`);
      console.log(`      Active alerts: ${d.activeAlerts?.length ?? 0}`);
    }
    pass++;
  } else {
    console.log(yellow("    ⚠  Dashboard endpoint unreachable"));
    fail++;
  }

  return { pass, fail };
}

// ─── Step 3: Verify row counts ────────────────────────────────────────────

async function verifyDB() {
  console.log(bold("\n🔍  Step 3 — Verifying database row counts…\n"));
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const tables = ["users", "products", "orders", "order_items", "query_log", "pool_snapshots", "anomaly_log", "app_users"];
  for (const t of tables) {
    try {
      const { rows } = await client.query(`SELECT COUNT(*) AS n FROM ${t}`);
      const n = parseInt(rows[0].n);
      console.log(`  ${t.padEnd(20)} ${n > 0 ? green(n + " rows") : yellow("0 rows (empty)")}`);
    } catch {
      console.log(`  ${t.padEnd(20)} ${red("table not found")}`);
    }
  }
  await client.end();
}

// ─── Main ─────────────────────────────────────────────────────────────────

(async () => {
  console.log(bold(cyan("\n══════════════════════════════════════════")));
  console.log(bold(cyan("   Ping-Pooler · Test Data Seeder")));
  console.log(bold(cyan("══════════════════════════════════════════")));
  console.log(`  DB:      ${DB_URL.replace(/:([^@]+)@/, ":***@")}`);
  console.log(`  Backend: ${BACKEND_URL}`);

  await applySeed();
  await verifyDB();
  const { pass, fail } = await warmMetrics();

  console.log(bold(cyan("\n══════════════════════════════════════════")));
  console.log(bold("   Seed Complete!"));
  console.log(`   ${green(pass + " API calls passed")}  ${fail > 0 ? red(fail + " failed") : green("all good ✓")}`);
  console.log(bold(cyan("══════════════════════════════════════════\n")));

  if (fail > 0) {
    console.log(yellow("  Tip: ensure the backend is running:  cd backend && bun run dev\n"));
  }
})();
