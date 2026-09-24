// Parses a PostgreSQL EXPLAIN (FORMAT JSON) plan into a tree, and generates a
// plausible plan + AI-style suggestions for a SQL string when no server is present.

export interface PlanNode {
  id: string;
  type: string;
  relation?: string | undefined;
  index?: string | undefined;
  cost: number;
  estRows: number;
  actualRows: number;
  timeMs: number;
  filter?: string | undefined;
  children: PlanNode[];
}

export interface Suggestion {
  id: string;
  kind: "INDEX_SUGGESTION" | "REWRITE_PROPOSAL" | "WARNING";
  title: string;
  detail: string;
  confidence: number;
  improvement: number;
  sql?: string;
}

type RawPlan = Record<string, unknown> & { Plans?: RawPlan[] };
let n = 0;
export function parseExplainJson(json: unknown): PlanNode {
  const root = Array.isArray(json) ? (json[0] as { Plan: RawPlan }).Plan : (json as { Plan: RawPlan }).Plan;
  const walk = (p: RawPlan): PlanNode => ({
    id: `n${n++}`,
    type: String(p["Node Type"] ?? "Unknown"),
    relation: p["Relation Name"] as string | undefined,
    index: p["Index Name"] as string | undefined,
    cost: Number(p["Total Cost"] ?? 0),
    estRows: Number(p["Plan Rows"] ?? 0),
    actualRows: Number(p["Actual Rows"] ?? p["Plan Rows"] ?? 0),
    timeMs: Number(p["Actual Total Time"] ?? 0),
    filter: (p["Filter"] ?? p["Index Cond"] ?? p["Hash Cond"]) as string | undefined,
    children: (p.Plans ?? []).map(walk),
  });
  return walk(root);
}

const tables = (sql: string) => [...sql.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1]);

export function simulatePlan(sql: string): PlanNode {
  const t = tables(sql);
  const hasJoin = t.length > 1;
  const likeWild = /like\s+'%/i.test(sql);
  const where = /\bwhere\b/i.test(sql);
  const scan = (rel: string, i: number): PlanNode => {
    const seq = likeWild || !where || i > 0 || /lower\(|->>/i.test(sql);
    const rows = seq ? Math.round(20000 + Math.random() * 80000) : Math.round(1 + Math.random() * 40);
    return {
      id: `s${i}-${rel}`,
      type: seq ? "Seq Scan" : "Index Scan",
      relation: rel,
      index: seq ? undefined : `${rel}_pkey`,
      cost: seq ? rows * 0.05 : 8.4,
      estRows: seq ? Math.round(rows * (0.4 + Math.random())) : rows,
      actualRows: rows,
      timeMs: seq ? rows / 900 : 0.05 + Math.random() * 0.3,
      filter: where ? sql.split(/where/i)[1]?.split(/order|group|limit/i)[0]?.trim() : undefined,
      children: [],
    };
  };
  let node: PlanNode;
  if (hasJoin) {
    const a = scan(t[0]!, 0);
    const b = scan(t[1]!, 1);
    const hash: PlanNode = { id: "hash", type: "Hash", cost: b.cost * 1.1, estRows: b.estRows, actualRows: b.actualRows, timeMs: b.timeMs * 1.2, children: [b] };
    node = { id: "join", type: "Hash Join", cost: a.cost + hash.cost + 400, estRows: a.estRows, actualRows: a.actualRows, timeMs: a.timeMs + hash.timeMs + 6, filter: sql.match(/on\s+([^\s]+\s*=\s*[^\s]+)/i)?.[1], children: [a, hash] };
  } else node = scan(t[0] ?? "table", 0);
  if (/group by/i.test(sql)) node = { id: "agg", type: "HashAggregate", cost: node.cost * 1.15, estRows: Math.round(node.estRows / 10), actualRows: Math.round(node.actualRows / 12), timeMs: node.timeMs * 1.3, children: [node] };
  if (/order by/i.test(sql)) node = { id: "sort", type: "Sort", cost: node.cost * 1.2, estRows: node.estRows, actualRows: node.actualRows, timeMs: node.timeMs * 1.25 + 2, filter: sql.match(/order by\s+([\w., ]+)/i)?.[1], children: [node] };
  if (/limit/i.test(sql)) node = { id: "limit", type: "Limit", cost: node.cost, estRows: 50, actualRows: 50, timeMs: node.timeMs + 0.1, children: [node] };
  return node;
}

export function flatten(p: PlanNode): PlanNode[] {
  return [p, ...p.children.flatMap(flatten)];
}

export function analyze(sql: string, plan: PlanNode): Suggestion[] {
  const out: Suggestion[] = [];
  const nodes = flatten(plan);
  for (const s of nodes.filter((x) => x.type === "Seq Scan" && x.actualRows > 5000)) {
    const col = s.filter?.match(/([a-z_]+)\s*(=|>|<|like)/i)?.[1] ?? "id";
    out.push({
      id: `idx-${s.id}`,
      kind: "INDEX_SUGGESTION",
      title: `Add index on ${s.relation}(${col})`,
      detail: `Sequential scan reads ${s.actualRows.toLocaleString()} rows on ${s.relation}. An index on ${col} would allow an index scan.`,
      confidence: 0.86,
      improvement: 72,
      sql: `CREATE INDEX CONCURRENTLY idx_${s.relation}_${col} ON ${s.relation} (${col});`,
    });
  }
  if (/select\s+\*/i.test(sql))
    out.push({ id: "star", kind: "REWRITE_PROPOSAL", title: "Select only needed columns", detail: "SELECT * fetches every column and prevents index-only scans.", confidence: 0.74, improvement: 18, sql: sql.replace(/select\s+\*/i, "SELECT id, created_at") });
  if (/like\s+'%/i.test(sql))
    out.push({ id: "like", kind: "WARNING", title: "Leading wildcard defeats B-tree indexes", detail: "Consider a pg_trgm GIN index or full-text search.", confidence: 0.9, improvement: 65, sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);" });
  const bad = nodes.find((x) => x.estRows > 0 && (x.actualRows / x.estRows > 5 || x.estRows / Math.max(1, x.actualRows) > 5));
  if (bad) out.push({ id: "stats", kind: "WARNING", title: "Row estimate is far off", detail: `${bad.type} estimated ${bad.estRows} rows but produced ${bad.actualRows}. Run ANALYZE on ${bad.relation ?? "the tables involved"}.`, confidence: 0.68, improvement: 12, sql: `ANALYZE ${bad.relation ?? ""};` });
  if (!/limit/i.test(sql) && /^\s*select/i.test(sql))
    out.push({ id: "limit", kind: "REWRITE_PROPOSAL", title: "Add a LIMIT for interactive queries", detail: "Unbounded result sets increase memory and network cost.", confidence: 0.55, improvement: 9, sql: sql.trim().replace(/;?$/, " LIMIT 100;") });
  return out;
}

export function routeFor(sql: string) {
  const s = sql.trim().toLowerCase();
  const write = /^(insert|update|delete|create|alter|drop|truncate|begin|with\s[\s\S]*\b(insert|update|delete)\b)/.test(s) || /for update/.test(s);
  return write ? { target: "primary", reason: "Write / locking statement" } : { target: Math.random() < 0.5 ? "replica-1" : "replica-2", reason: "Read-only SELECT, replica lag within threshold" };
}

export function simulateRows(sql: string) {
  const cols = sql.match(/select\s+(.*?)\s+from/is)?.[1];
  const names = !cols || cols.trim() === "*" ? ["id", "name", "status", "created_at"] : cols.split(",").map((c) => c.trim().split(/\s+as\s+|\s+/i).pop()!.replace(/^\w+\./, ""));
  const rows = Array.from({ length: 12 }, (_, i) =>
    Object.fromEntries(names.map((c) => [c, c.includes("id") ? 1000 + i : c.includes("at") ? new Date(Date.now() - i * 3.6e6).toISOString().slice(0, 19) : c.includes("count") ? Math.round(Math.random() * 40) : `${c}_${i + 1}`])),
  );
  return { columns: names, rows };
}
