# Insightful Routes

# PG-ROUTER-AI BACKEND SPECIFICATION

## Project Overview

Build a Node.js/TypeScript backend for pg-router-ai: an AI-powered PostgreSQL query routing and 

observability platform. The backend handles SQL query routing, AI-powered analysis, anomaly detection, 

and real-time monitoring via WebSockets.

## Tech Stack

- Runtime: Node.js 18+

- Language: TypeScript

- Framework: Express.js

- Database: PostgreSQL (primary + replicas), Redis (caching/metrics)

- AI/ML: Hugging Face Inference API, Google Gemini API

- Real-time: Socket.io

- Testing: Jest

- Documentation: Swagger/OpenAPI

## Directory Structure & File Specifications

### /src/router/ — Core Query Routing Engine

Purpose: Parse SQL, determine read/write, route to appropriate database node

Files:

- index.ts — Main router export, orchestrates routing flow

- parser.ts — SQL parsing using node-sql-parser

  - Input: Raw SQL string

  - Output: AST with query type (SELECT/INSERT/UPDATE/DELETE), tables, complexity score

  - Functions: parseQuery(), extractTables(), isWriteQuery()

- transaction-state.ts — Transaction state machine

  - Track BEGIN/COMMIT/ROLLBACK/SAVEPOINT across connections

  - Lock routing to primary during active transactions

  - Functions: startTransaction(), commit(), rollback(), isInTransaction()

- pool-manager.ts — Connection pool management

  - Wraps node-postgres pools for primary and each replica

  - Health checks, connection limits, round-robin for replicas

  - Functions: getPoolForQuery(), getReplica(), checkHealth()

- query-router.ts — Main routing decision logic

  - Combines parser + transaction state + pool manager

  - Routes: SELECT (no transaction) → replica; WRITE/transaction → primary

  - Functions: routeQuery(), executeQuery(), getQueryStats()

### /src/ai/ — AI-Powered Analysis Engine

Purpose: Leverage Hugging Face and Gemini for query intelligence

Files:

- index.ts — AI module exports and configuration

- optimizer.ts — Query optimization suggestions

  - Uses Gemini to analyze slow queries

  - Input: SQL + execution time + EXPLAIN plan

  - Output: Index recommendations, rewrite suggestions, warnings

  - Functions: analyzeQuery(), suggestIndexes(), rewriteQuery()

  - Cache results in Redis (TTL: 1 hour)

- anomaly.ts — Anomaly detection using embeddings

  - Uses Hugging Face sentence-transformers to embed normalized queries

  - Maintains historical pattern in Redis (rolling window)

  - Detects: N+1 patterns, sudden volume spikes, new query types

  - Functions: embedQuery(), detectAnomaly(), getPatternHistory()

  - Alert via Socket.io when anomaly detected

- nl-to-sql.ts — Natural language to SQL conversion

  - Uses Gemini with schema context

  - Input: Natural language question + schema description

  - Output: Generated SQL + confidence score + routing decision

  - Functions: convertToSQL(), validateGeneratedSQL()

### /src/monitors/ — Health & Performance Monitoring

Purpose: Track database health, replica lag, query metrics

Files:

- index.ts — Monitor exports

- health-checker.ts — Database health monitoring

  - Periodic checks (every 5s) for all nodes

  - Check: connection, replication lag, query response time

  - Update Redis with node status

  - Functions: checkPrimary(), checkReplica(), getHealthyReplicas()

- metrics-collector.ts — Query metrics aggregation

  - Track: query duration, row counts, error rates, routing decisions

  - Store in Redis with time-series format

  - Functions: recordQueryMetrics(), getMetrics(), getSlowQueries()

- lag-monitor.ts — Replica lag tracking

  - Query pg_stat_replication on primary

  - Alert if lag > threshold (configurable, default 1s)

  - Functions: getReplicationLag(), isReplicaStale()

### /src/replay/ — Query Replay Engine

Purpose: Capture and replay production queries for testing

Files:

- index.ts — Replay module exports

- capture.ts — Query capture to file

  - Stream queries to log file with timestamps

  - Rotate files daily

  - Functions: startCapture(), stopCapture(), writeQuery()

- replay.ts — Replay captured queries

  - Read capture file, execute against target database

  - Support speed modifiers (0.5x, 1x, 2x, 10x)

  - Compare results with original

  - Functions: replayQueries(), compareResults(), getReplayStats()

### /src/api/ — REST API & WebSocket Handlers

Purpose: HTTP endpoints and Socket.io events for frontend

Files:

- index.ts — Express app setup, middleware

- routes/

  - queries.ts — POST /api/query (execute query), GET /api/queries (history)

  - health.ts — GET /api/health (system status), GET /api/nodes (db nodes)

  - metrics.ts — GET /api/metrics (time-series data), GET /api/slow-queries

  - ai.ts — POST /api/ai/optimize (optimize query), POST /api/ai/convert (nl-to-sql)

  - replay.ts — POST /api/replay/start, GET /api/replay/status

- socket/

  - events.ts — Socket.io event handlers

    - connection: client connected

    - subscribe:metrics — stream real-time metrics

    - subscribe:alerts — receive anomaly alerts

    - execute:query — execute query via WebSocket (for collaborative editor)

### /src/config/ — Configuration Management

Files:

- database.ts — PostgreSQL connection configs (primary, replicas)

- ai.ts — Hugging Face and Gemini API keys, model selection

- redis.ts — Redis connection

- app.ts — App-level config (port, log level, thresholds)

### /src/types/ — TypeScript Type Definitions

Files:

- query.ts — Query, QueryResult, QueryPlan, RoutingDecision types

- database.ts — DatabaseNode, NodeHealth, ConnectionPool types

- ai.ts — OptimizationSuggestion, AnomalyAlert, NLQuery types

- metrics.ts — MetricsSnapshot, TimeSeriesPoint types

- socket.ts — Socket event payload types

### /src/utils/ — Utilities

Files:

- logger.ts — Winston logger configuration

- errors.ts — Custom error classes (QueryError, RoutingError, AIError)

- validators.ts — Input validation (SQL injection checks, query limits)

- helpers.ts — General utilities (timing, formatting)

## Key Relationships

1. router/query-router.ts → ai/optimizer.ts

   - After routing, if query is slow, trigger AI analysis

2. router/query-router.ts → monitors/metrics-collector.ts

   - Record every routed query's metrics

3. monitors/health-checker.ts → router/pool-manager.ts

   - Health status determines available pools

4. ai/anomaly.ts → api/socket/events.ts

   - Anomalies emit Socket.io alerts to frontend

5. api/routes/queries.ts → router/query-router.ts

   - HTTP API calls routing engine

6. All AI modules → config/ai.ts

   - Shared API configuration and rate limiting

## Environment Variables

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/075ccef5-7937-4548-9345-41423b8f9b14).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development
Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
