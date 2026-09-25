/**
 * Anomaly Simulation Script for pg-router-ai
 * Generates test traffic designed to trigger all 4 anomaly types:
 * 1. N+1 Query Pattern
 * 2. Volume Spike
 * 3. New Query Shape (Semantic Vector Anomaly)
 * 4. Latency Spike
 */

const routerUrl = (process.env.PG_ROUTER_URL || 'http://localhost:3000').replace(/\/$/, '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendQuery(sql, params = []) {
  try {
    const res = await fetch(`${routerUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    return await res.json();
  } catch (err) {
    console.error(`[simulate-anomalies] Failed: ${err.message}`);
  }
}

async function triggerNPlusOne() {
  console.log('\n[1/4] 🚨 Triggering N+1 Query Pattern Anomaly...');
  const sql = 'SELECT * FROM users WHERE id = $1';
  // Send 10 identical queries in rapid succession (< 2000ms window)
  for (let i = 1; i <= 10; i++) {
    await sendQuery(sql, [i]);
    await sleep(20);
  }
  console.log('✅ N+1 query burst completed.');
}

async function triggerVolumeSpike() {
  console.log('\n[2/4] 🚨 Triggering Volume Spike Anomaly...');
  const promises = [];
  // Send 30 queries simultaneously in a tight 10s window
  for (let i = 0; i < 30; i++) {
    promises.push(sendQuery(`SELECT name, setting FROM pg_settings WHERE name LIKE 'max_%' LIMIT ${i % 5 + 1}`));
  }
  await Promise.all(promises);
  console.log('✅ Volume spike burst completed.');
}

async function triggerNewQueryShape() {
  console.log('\n[3/4] 🚨 Triggering New Query Shape Anomaly...');
  const sql = `SELECT json_agg(json_build_object('custom_id', t.oid, 'name', t.typname)) FROM pg_type t WHERE t.typlen > 4 AND t.typname ILIKE '%user%'`;
  await sendQuery(sql);
  console.log('✅ New query shape executed.');
}

async function triggerLatencySpike() {
  console.log('\n[4/4] 🚨 Triggering Latency Spike Anomaly...');
  // Execute a query with pg_sleep to trigger slow query threshold (>100ms)
  const sql = `SELECT pg_sleep(0.2), 'slow_query_simulation' AS status`;
  await sendQuery(sql);
  console.log('✅ Latency spike query completed.');
}

async function main() {
  console.log('====================================================');
  console.log('🔥 pg-router-ai Anomaly Simulator Starting...');
  console.log(`Target Router URL: ${routerUrl}`);
  console.log('====================================================');

  await triggerNPlusOne();
  await sleep(1000);

  await triggerVolumeSpike();
  await sleep(1000);

  await triggerNewQueryShape();
  await sleep(1000);

  await triggerLatencySpike();

  console.log('\n====================================================');
  console.log('🎉 All anomaly triggers executed successfully!');
  console.log('Check your Anomaly Dashboard at http://localhost:5173/anomalies');
  console.log('====================================================\n');
}

main();
