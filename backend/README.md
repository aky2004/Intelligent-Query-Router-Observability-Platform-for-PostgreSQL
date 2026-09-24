# pg-router-ai — backend

AI-powered PostgreSQL query routing and observability platform.

Reads go to replicas, writes and transactions go to the primary, every query is
measured, slow queries get AI analysis, and unusual traffic raises real-time
alerts over WebSockets.

## Quick start

```bash
cd backend
cp .env.example .env     # SIMULATE_DB=true needs no real databases
npm install
npm run dev              # http://localhost:3000, docs at /docs
npm test
```

Add `GEMINI_API_KEY` and `HUGGINGFACE_API_KEY` to `.env` to enable AI features.
Without them, optimization falls back to rule-based heuristics, anomaly
detection uses a local embedding, and natural-language-to-SQL is disabled.
Redis is optional — without `REDIS_URL` an in-memory store is used.

## Layout

```
src/
  router/     parser, transaction state machine, pool manager, routing engine
  ai/         Gemini optimizer, embedding anomaly detection, NL-to-SQL
  monitors/   health checker, metrics collector, replica lag monitor
  replay/     query capture (daily-rotating JSONL) and replay with speed control
  api/        Express app, REST routes, Socket.io events, OpenAPI doc
  config/     app, database, redis, ai configuration
  types/      shared TypeScript types
  utils/      logger, errors, validators, helpers
```

## REST API

Every response uses `{ success, data?, error?, meta }`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/query` | Route and execute a statement |
| POST | `/api/query/explain` | Routing decision only |
| GET | `/api/queries` | Query history and routing stats |
| GET | `/api/health` | System status |
| GET | `/api/nodes` | Nodes, pools, replica lag |
| GET | `/api/metrics` | Snapshot plus time series |
| GET | `/api/slow-queries` | Slowest recent queries |
| POST | `/api/ai/optimize` | Index / rewrite suggestions |
| POST | `/api/ai/convert` | Natural language to SQL |
| GET | `/api/ai/patterns` | Learned query shapes |
| POST | `/api/replay/capture/start`, `/stop` | Control capture |
| POST | `/api/replay/start` | Replay at 0.5x / 1x / 2x / 10x |
| GET | `/api/replay/status` | Capture and replay state |

## WebSocket events

Client → server: `subscribe:metrics`, `unsubscribe:metrics`, `subscribe:alerts`, `execute:query`.
Server → client: `metrics:update`, `health:update`, `alert:anomaly`, `query:executed`.
Pass a JWT in the handshake (`io(url, { auth: { token } })`); it is enforced in production.

## Safeguards

- One statement per request, injection heuristics, 20k SQL length cap
- 100 requests/minute per IP, helmet and CORS
- Circuit breaker plus per-minute rate limiting on every AI provider call
- AI results cached in Redis for one hour

## Dashboard API & integration

The dashboard pages talk to `src/api/routes/dashboard.ts`:

| Area | Endpoints |
|---|---|
| Dashboard | `GET /api/metrics/dashboard` · socket `metrics:update` |
| Metrics | `GET /api/nodes` (polled 5s) · `GET /api/metrics/timeseries?start&end&interval` · socket `node:status`, `metrics:timeseries` |
| Explorer | `POST /api/query/execute` · `POST /api/ai/analyze` · `POST /api/ai/convert` · `GET /api/queries/history` · socket rooms `query-editor-*` (`editor:join/leave/sync`, `cursor:update`, `user:joined/left`) |
| Anomalies | `GET /api/anomalies?severity&timeRange&limit` · `POST /api/anomalies/:id/acknowledge` · socket `alert:new` |
| Replay | `POST /api/replay/upload` (multipart `file`) · `POST /api/replay/start` · `GET /api/replay/:id/status` · `POST /api/replay/:id/pause|resume` · `GET /api/replay/:id/comparison` · socket `replay:progress`, `replay:complete` |
| Settings | `GET /api/settings` · `PUT /api/settings/thresholds|ai|live-updates` · `POST /api/nodes` · `DELETE /api/nodes/:id` · `POST /api/nodes/:id/test` |

**Auth:** the dashboard signs in with Google and sends that access token as
`Authorization: Bearer …` and in the socket handshake. Set `SUPABASE_URL` and
`SUPABASE_ANON_KEY` (see `.env.example`) so the backend accepts it.

### Testing locally (no auth, simulated databases)

```bash
cd backend && npm install
AUTH_DISABLED=true npm run dev          # http://localhost:3000, API docs at /docs
curl localhost:3000/api/metrics/dashboard
curl -H 'Content-Type: application/json' -d '{"sql":"SELECT * FROM users"}' localhost:3000/api/query/execute
npm test
```

### Connecting the hosted dashboard

The hosted dashboard is served over HTTPS, so it needs a backend with a public **https** address.

1. Deploy the backend (Render / Railway / Fly.io / a VM) with Redis, `SIMULATE_DB=false`,
   `PRIMARY_DATABASE_URL`, `REPLICA_DATABASE_URLS`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `CORS_ORIGIN=<dashboard URL>`. Quick test from a laptop:
   `npx cloudflared tunnel --url http://localhost:3000` gives a temporary https address.
2. In the dashboard open **Settings → Backend connection**, paste the address, click **Connect**.
3. The header badge shows **live · backend**. If the backend drops it shows **offline · cached**
   with Retry; with no backend at all it uses simulated data.
