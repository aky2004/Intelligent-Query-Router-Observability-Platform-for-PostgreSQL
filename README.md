# 🐘 pg-router-ai

> **Intelligent PostgreSQL Query Router, Wire-Protocol Proxy & AI Observability Platform**

`pg-router-ai` is a high-performance PostgreSQL smart proxy and real-time observability control plane. It sits transparently between your applications and database infrastructure to provide **zero-downtime read/write splitting**, **TCP wire-protocol interception**, **AWS Bedrock / DeepSeek AI query safety analysis**, **anomaly detection**, and **traffic replay**.

---

## ⚡ Core Features

- 🔌 **PostgreSQL TCP Wire-Protocol Proxy (`port 5433`)**: Intercepts native PostgreSQL binary traffic directly via `DATABASE_URL="postgresql://user:pass@host:5433/db"`. Compatible out-of-the-box with Prisma, Drizzle, TypeORM, Kysely, `pg`, Django, Rails, and Go drivers.
- 🔀 **Smart Read/Write Splitting**: Automatically routes write queries (`INSERT`, `UPDATE`, `DELETE`, `DDL`, `SELECT ... FOR UPDATE`) to the Primary database and balances read queries (`SELECT`) across healthy Replicas.
- ⚖️ **Weighted Least-Connections Load Balancing**: Distributes read workloads dynamically based on active pool pressure and replication lag rather than simple round-robin.
- 🛡️ **Circuit Breaker & Transparent Failover**: Continuously monitors replica health. Automatically trips broken nodes out of rotation and reroutes queries to the Primary with zero client downtime.
- 🤖 **AI Query Safety & Anomaly Detection**: Powered by **DeepSeek v3.2 via AWS Bedrock Converse API** and vector embedding similarity to block SQL injection, catastrophic unindexed `DELETE`/`UPDATE` queries, and detect N+1 query patterns.
- 🔄 **Production Traffic Capture & Replay**: Continuous newline-delimited JSON (`.jsonl`) query logging. Replay captured workloads against target databases at variable speeds (`0.5×` to `10×`) with automated result & row-count diffing.
- 📊 **Real-Time Observability Dashboard**: Built with TanStack Router, React, and WebSockets. Live QPS metrics, average latency, slow query explain plans, pool pressure, and active alerts.
- 💾 **Dynamic Onboarding & Persistence**: Connect new primary or replica databases on-the-fly via the UI with disk-backed state persistence (`nodes-store.json`).

---

## 🏗️ Architecture Overview

```mermaid
flowchart TD
    App[Client App / ORM] -->|DATABASE_URL on port 5433| TCPProxy[PG Wire TCP Proxy]
    App -->|HTTP REST on port 3000| RESTAPI[Dashboard REST & WS API]

    subgraph RouterCore[pg-router-ai Core]
        TCPProxy --> QueryRouter[Query Router & Parser]
        RESTAPI --> QueryRouter
        QueryRouter --> CircuitBreaker[Circuit Breaker & Pool Manager]
        QueryRouter --> AISafety[DeepSeek AI & Vector Evaluator]
        QueryRouter --> Logger[Query Capture & Metrics Collector]
    end

    CircuitBreaker -->|Writes & Transactions| Primary[(Primary PostgreSQL)]
    CircuitBreaker -->|Balanced Reads| Replica1[(Replica Database 1)]
    CircuitBreaker -->|Balanced Reads| Replica2[(Replica Database 2)]

    Logger --> DashboardUI[Live Observability Dashboard]
```

---

## 🛠️ Technology Stack

- **Frontend**: React 18, TanStack Start & TanStack Router, TailwindCSS, Lucide Icons, Recharts, Sonner.
- **Backend Core**: Node.js / Bun, TypeScript, Express, Socket.io, `pg` (node-postgres), `ioredis`.
- **AI & Security**: AWS Bedrock Runtime SDK (`@aws-sdk/client-bedrock-runtime`), DeepSeek v3.2, Vector Similarity Engine.
- **Protocols**: PostgreSQL v3.0 TCP Wire Protocol (`net.Server`), HTTP/1.1 REST API, WebSockets.

---

## 🚀 Quickstart Guide

### 1. Clone & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/aky2004/pg-router-ai-Intelligent-Query-Router-Observability-Platform-for-PostgreSQL.git
cd pg-router-ai-Intelligent-Query-Router-Observability-Platform-for-PostgreSQL

# Install frontend dependencies
bun install   # or npm install

# Install backend dependencies
cd backend && bun install && cd ..
```

### 2. Environment Configuration

Copy the example environment files:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your credentials:

```env
# Server Ports
PORT=3000
PG_PROXY_PORT=5433

# AWS Bedrock / DeepSeek AI (Optional)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
BEDROCK_MODEL_ID=deepseek.v3.2

# Redis Cache (Optional, falls back to in-memory store if unset)
REDIS_URL=redis://localhost:6379
```

### 3. Start Development Servers

Run backend and frontend concurrently:

```bash
# Terminal 1: Start Backend (REST API + PG Wire Proxy)
cd backend && bun run dev

# Terminal 2: Start Frontend Dashboard
bun run dev
```

The services will be available at:
- 🌐 **Dashboard UI**: `http://localhost:5173`
- 📡 **REST API**: `http://localhost:3000`
- 🔌 **PostgreSQL TCP Wire Proxy**: `localhost:5433`

---

## 🔌 Intercepting Your App's Database Traffic

1. Open `http://localhost:5173/settings` in your browser.
2. Enter your primary PostgreSQL database connection string (e.g. Neon, Supabase, RDS).
3. Copy the generated interceptor string:
   ```env
   DATABASE_URL="postgresql://username:password@localhost:5433/yourdb?sslmode=disable"
   ```
4. Paste the `DATABASE_URL` into your target application's `.env`.
5. Execute queries in your app — all read/write traffic, latencies, and security evaluations will stream live into your `pg-router-ai` dashboard!

---

## 📡 API Reference

### PostgreSQL Wire Proxy (`tcp://localhost:5433`)
Connect any PostgreSQL client or ORM directly using `DATABASE_URL`.

### REST API Endpoints (`http://localhost:3000`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/query/execute` | Executes an SQL query through the routing pipeline |
| `GET` | `/api/nodes` | Returns list of connected database nodes and health status |
| `POST` | `/api/nodes` | Connects a new database node at runtime |
| `DELETE` | `/api/nodes/:id` | Disconnects a database node |
| `GET` | `/api/metrics/dashboard` | Returns cluster metrics, QPS, latency & connection pressure |
| `GET` | `/api/replay/live-capture` | Returns active captured `.jsonl` traffic log |
| `GET` | `/api/replay/download` | Downloads active newline-delimited JSON log file |
| `POST` | `/api/replay/start` | Initiates a query replay run against a target node |
| `POST` | `/api/ai/safety` | Evaluates SQL safety using DeepSeek Bedrock |

---

## 📜 License

This project is licensed under the MIT License.
