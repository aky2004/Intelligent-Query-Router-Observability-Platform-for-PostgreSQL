import type { DatabaseNode } from "../types/database";
import { sleep } from "../utils/helpers";

/**
 * Deterministic in-memory stand-in for a PostgreSQL node. Used when
 * SIMULATE_DB=true so the whole platform can run without real databases.
 */
const TABLES: Record<string, Array<Record<string, unknown>>> = {
  users: Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    email: `user${i + 1}@example.com`,
    created_at: new Date(Date.now() - i * 86_400_000).toISOString(),
  })),
  orders: Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    user_id: (i % 50) + 1,
    total_cents: 1000 + i * 37,
    status: ["pending", "paid", "shipped"][i % 3],
  })),
  products: Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    name: `Product ${i + 1}`,
    price_cents: 500 + i * 125,
  })),
};

export interface SimulatedResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  fields: string[];
}

export class SimulatedClient {
  constructor(private node: DatabaseNode) {}

  async query(sql: string, tables: string[]): Promise<SimulatedResult> {
    // Replicas answer a touch slower, primaries carry write latency.
    const base = this.node.role === "replica" ? 4 : 6;
    const jitter = Math.random() * 25;
    await sleep(base + jitter);

    if (/^\s*explain/i.test(sql)) {
      return {
        rows: [{ "QUERY PLAN": buildExplainPlan(sql, tables) }],
        rowCount: 1,
        fields: ["QUERY PLAN"],
      };
    }

    if (/^\s*(begin|commit|rollback|savepoint|release|set|create|alter|drop|truncate)/i.test(sql)) {
      return { rows: [], rowCount: 0, fields: [] };
    }

    if (/^\s*(insert|update|delete)/i.test(sql)) {
      return { rows: [], rowCount: 1 + Math.floor(Math.random() * 5), fields: [] };
    }

    const table = tables.find((t) => TABLES[t.split(".").pop() ?? ""]) ?? "users";
    const data = TABLES[table.split(".").pop() ?? "users"] ?? TABLES.users;
    const limitMatch = sql.match(/\blimit\s+(\d+)/i);
    const limit = limitMatch ? Number(limitMatch[1]) : 25;
    const rows = data.slice(0, Math.min(limit, data.length)).map((row) => ({ ...row }));
    return { rows, rowCount: rows.length, fields: Object.keys(rows[0] ?? {}) };
  }

  async replicationLagMs(): Promise<number> {
    return this.node.role === "replica" ? Math.round(Math.random() * 1400) : 0;
  }
}

const buildExplainPlan = (sql: string, tables: string[]): string => {
  const table = tables[0] ?? "users";
  const hasJoin = /\bjoin\b/i.test(sql);
  const lines = [
    `Seq Scan on ${table}  (cost=0.00..431.00 rows=1200 width=64) (actual time=0.021..12.430 rows=1200 loops=1)`,
  ];
  if (hasJoin) {
    lines.unshift("Hash Join  (cost=18.50..902.75 rows=2400 width=128) (actual time=0.340..48.900 rows=2400 loops=1)");
    lines.push("  ->  Hash  (cost=14.30..14.30 rows=340 width=64)");
  }
  lines.push("Planning Time: 0.180 ms", "Execution Time: 54.210 ms");
  return lines.join("\n");
};

export const simulatedSchemaDescription = Object.entries(TABLES)
  .map(([table, rows]) => `TABLE ${table} (${Object.keys(rows[0] ?? {}).join(", ")})`)
  .join("\n");
