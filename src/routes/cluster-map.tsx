import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { toast } from "sonner";
import {
  Database,
  Network,
  Server,
  ArrowRight,
  ArrowDown,
  RefreshCw,
  Search,
  Key,
  Link2,
  Table as TableIcon,
  Sparkles,
  Info,
  CheckCircle2,
  ShieldCheck,
  Zap,
  Activity,
  Layers,
  HelpCircle,
  ExternalLink,
} from "lucide-react";
import { api, errorMessage, isBackendConfigured } from "@/lib/api";
import { useSim } from "@/lib/sim";
import { PageHeader, Panel, StatusDot } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/cluster-map")({
  head: () => ({
    meta: [
      { title: "Cluster Map & Schema — pg-router-ai" },
      { name: "description", content: "Visual topology of your Primary and Replica database nodes and live schema structure." },
      { property: "og:title", content: "Cluster Map & Schema — pg-router-ai" },
      { property: "og:description", content: "Visual topology of your Primary and Replica database nodes and live schema structure." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ClusterMap,
});

interface ColumnDetail {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  references: {
    table: string;
    column: string;
  } | null;
}

interface TableDetail {
  name: string;
  estimatedRows: number;
  columns: ColumnDetail[];
}

interface SchemaResponse {
  databaseName: string;
  serverVersion?: string;
  isSimulated: boolean;
  hasConnectedPrimary: boolean;
  tables: TableDetail[];
  totalTables: number;
  totalEstimatedRows: number;
  inspectedAt: string;
}

function ClusterMap() {
  const nodes = useSim((s) => s.nodes);
  const live = useSim((s) => s.source === "live");
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [search, setSearch] = useState("");
  const [simpleMode, setSimpleMode] = useState(true);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const primaryNode = nodes.find((n) => n.role === "primary");
  const replicaNodes = nodes.filter((n) => n.role === "replica");

  const loadSchema = async () => {
    setLoading(true);
    try {
      if (isBackendConfigured()) {
        const data = await api<SchemaResponse>("/api/schema", { retries: 1 });
        setSchema(data);
      } else {
        // Fallback default
        setSchema({
          databaseName: "simulated_cluster",
          serverVersion: "PostgreSQL 16 (Simulated)",
          isSimulated: true,
          hasConnectedPrimary: false,
          tables: [],
          totalTables: 0,
          totalEstimatedRows: 0,
          inspectedAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSchema();
  }, [live, nodes.length]);

  const handleSeedDemo = async () => {
    setSeeding(true);
    try {
      const res = await api<{ success: boolean; message: string }>("/api/schema/seed", {
        method: "POST",
      });
      toast.success(res.message);
      await loadSchema();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSeeding(false);
    }
  };

  const filteredTables = useMemo(() => {
    if (!schema?.tables) return [];
    if (!search.trim()) return schema.tables;
    const q = search.toLowerCase();
    return schema.tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.columns.some((c) => c.name.toLowerCase().includes(q) || c.type.toLowerCase().includes(q))
    );
  }, [schema?.tables, search]);

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Cluster Architecture & Database Schema"
        sub="High-level visual topology of your PostgreSQL cluster routing and live tables."
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs shadow-xs">
            <Label htmlFor="simple-mode-toggle" className="cursor-pointer font-medium text-muted-foreground">
              {simpleMode ? "👔 Non-Tech View" : "🛠️ Engineering View"}
            </Label>
            <Switch
              id="simple-mode-toggle"
              checked={simpleMode}
              onCheckedChange={setSimpleMode}
              aria-label="Toggle simplified view"
            />
          </div>
          <Button variant="outline" size="sm" onClick={loadSchema} disabled={loading} className="gap-1.5 text-xs">
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {(!schema?.tables || schema.tables.length === 0 || schema.isSimulated) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSeedDemo}
              disabled={seeding}
              className="gap-1.5 text-xs"
            >
              <Sparkles className="size-3.5 text-amber-500" />
              {seeding ? "Creating demo tables..." : "Load Sample Schema"}
            </Button>
          )}
        </div>
      </PageHeader>

      {/* ─────────────────── TOPOLOGY DIAGRAM ─────────────────── */}
      <Panel
        title="Cluster Routing Topology"
        action={
          <span className="font-mono text-xs text-muted-foreground">
            {primaryNode ? "1 Primary" : "0 Primary"} · {replicaNodes.length} Replicas
          </span>
        }
      >
        <div className="relative overflow-hidden rounded-xl border border-border/60 bg-linear-to-b from-muted/30 to-background/80 p-6 md:p-8">
          {/* Incoming App Traffic Node */}
          <div className="mx-auto max-w-sm text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 shadow-xs">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              <span className="font-display text-xs font-semibold tracking-wide text-foreground">
                {simpleMode ? "Your Application / Users" : "Client Application Traffic"}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {simpleMode
                ? "Sends queries to pg-router proxy instead of directly to one database"
                : "PostgreSQL Wire Protocol (TCP port 5433) & REST API"}
            </p>
          </div>

          {/* Router Pipeline Box */}
          <div className="my-6 mx-auto flex max-w-md flex-col items-center">
            <div className="flex h-6 w-0.5 bg-border" />
            <div className="w-full rounded-lg border border-border bg-card p-3 shadow-sm text-center">
              <div className="flex items-center justify-center gap-2">
                <Network className="size-4 text-emerald-500" />
                <span className="font-display text-xs font-semibold">pg-router-ai Intelligent Router</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {simpleMode
                  ? "🧠 Inspects SQL: Writes go to Primary, Reads get load-balanced to Replicas"
                  : "Transaction-aware AST parsing · Least-connections balancing · Transparent failover"}
              </p>
            </div>
            <div className="flex h-6 w-0.5 bg-border" />
          </div>

          {/* Database Nodes Split */}
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {/* Primary Node Card */}
            <div className="relative rounded-xl border-2 border-emerald-500/40 bg-card p-5 shadow-sm transition-all hover:border-emerald-500/70">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="grid size-8 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
                    <Server className="size-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-display text-sm font-bold">
                        {simpleMode ? "Primary Database" : primaryNode?.id ?? "Primary Node"}
                      </span>
                      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-500">
                        {simpleMode ? "👑 Write Leader" : "PRIMARY (RW)"}
                      </Badge>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {primaryNode?.host ?? "Not connected"}
                    </span>
                  </div>
                </div>
                {primaryNode && <StatusDot status={primaryNode.status} />}
              </div>

              <div className="mt-4 rounded-md bg-muted/50 p-2.5 text-[11px] text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span>Routing Rule:</span>
                  <span className="font-medium text-emerald-500">Writes & Transactions</span>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
                  {simpleMode
                    ? "All new data (INSERT, UPDATE, DELETE) is safely written here first."
                    : "Handles all DDL, DML writes and open transaction blocks with 0 replication lag."}
                </p>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 font-mono text-xs">
                <div className="rounded border bg-background/50 p-2">
                  <span className="block text-[10px] uppercase text-muted-foreground">Connections</span>
                  <span className="font-semibold">{primaryNode?.connections ?? 0} / {primaryNode?.maxConnections ?? 20}</span>
                </div>
                <div className="rounded border bg-background/50 p-2">
                  <span className="block text-[10px] uppercase text-muted-foreground">Latency</span>
                  <span className="font-semibold">{primaryNode ? `${primaryNode.latencyMs.toFixed(1)}ms` : "—"}</span>
                </div>
              </div>
            </div>

            {/* Replicas Cards */}
            {replicaNodes.length > 0 ? (
              replicaNodes.map((rep, idx) => (
                <div
                  key={rep.id}
                  className="relative rounded-xl border border-sky-500/40 bg-card p-5 shadow-sm transition-all hover:border-sky-500/70"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="grid size-8 place-items-center rounded-lg bg-sky-500/15 text-sky-500">
                        <Database className="size-4" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-display text-sm font-bold">
                            {simpleMode ? `Read Replica ${idx + 1}` : rep.id}
                          </span>
                          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-[10px] text-sky-500">
                            {simpleMode ? "📋 Fast Reads" : "REPLICA (RO)"}
                          </Badge>
                        </div>
                        <span className="font-mono text-[11px] text-muted-foreground">{rep.host}</span>
                      </div>
                    </div>
                    <StatusDot status={rep.status} />
                  </div>

                  <div className="mt-4 rounded-md bg-muted/50 p-2.5 text-[11px] text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span>Replication Lag:</span>
                      <span className="font-medium text-sky-500">{Math.round(rep.lagMs)}ms lag</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
                      {simpleMode
                        ? "Answers SELECT queries without disturbing the Primary database."
                        : "Synchronized via PostgreSQL streaming replication. Weighted least-connections routing."}
                    </p>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2 font-mono text-xs">
                    <div className="rounded border bg-background/50 p-2">
                      <span className="block text-[10px] uppercase text-muted-foreground">Connections</span>
                      <span className="font-semibold">{rep.connections} / {rep.maxConnections}</span>
                    </div>
                    <div className="rounded border bg-background/50 p-2">
                      <span className="block text-[10px] uppercase text-muted-foreground">Throughput</span>
                      <span className="font-semibold">{rep.queriesRouted} queries</span>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="relative flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center">
                <Database className="size-8 text-muted-foreground/40" />
                <h3 className="mt-2 text-sm font-medium">No Read Replicas Connected</h3>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                  {simpleMode
                    ? "Currently, read queries also run on the primary. Connect a replica to divide the workload!"
                    : "Add read replicas in Settings → Database Nodes to enable automatic read/write splitting."}
                </p>
                <Button asChild variant="outline" size="sm" className="mt-3 text-xs">
                  <Link to="/settings">Connect Replica</Link>
                </Button>
              </div>
            )}

            {/* Non-Tech Explanation Card */}
            <div className="rounded-xl border border-border/70 bg-card/60 p-5 backdrop-blur-sm">
              <div className="flex items-center gap-2">
                <Info className="size-4 text-primary" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {simpleMode ? "What does this mean?" : "Routing Logic Overview"}
                </h3>
              </div>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 size-1.5 rounded-full bg-emerald-500 shrink-0" />
                  <span>
                    <strong className="text-foreground">Writes & Signups:</strong> Routed to the Primary leader so data is never lost.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 size-1.5 rounded-full bg-sky-500 shrink-0" />
                  <span>
                    <strong className="text-foreground">Reads & Dashboards:</strong> Spread across Replicas to keep response times under 15ms.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5 size-1.5 rounded-full bg-amber-500 shrink-0" />
                  <span>
                    <strong className="text-foreground">Lag Protection:</strong> If a replica falls behind by &gt;1s, the router automatically falls back to Primary.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </Panel>

      {/* ─────────────────── DATABASE SCHEMA EXPLORER ─────────────────── */}
      <Panel
        title="Live Database Schema Structure"
        action={
          <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
            <span>DB: <strong className="text-foreground">{schema?.databaseName ?? "loading..."}</strong></span>
            <span>·</span>
            <span>{schema?.totalTables ?? 0} Tables</span>
            <span>·</span>
            <span>~{schema?.totalEstimatedRows.toLocaleString() ?? 0} Total Records</span>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                placeholder="Search tables or columns..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 text-xs"
              />
            </div>
            {schema?.isSimulated && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Sparkles className="size-3 text-amber-500" />
                Sample Simulated Structure Active
              </Badge>
            )}
          </div>

          {loading ? (
            <div className="flex h-48 flex-col items-center justify-center font-mono text-xs text-muted-foreground">
              <RefreshCw className="size-5 animate-spin text-primary" />
              <span className="mt-2">Introspecting PostgreSQL information_schema...</span>
            </div>
          ) : filteredTables.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
              <TableIcon className="size-8 text-muted-foreground/40" />
              <h3 className="mt-2 text-sm font-medium">No Tables Found</h3>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                {search
                  ? `No tables or columns match "${search}". Try searching for something else.`
                  : "The connected database public schema is currently empty. Click below to load sample tables!"}
              </p>
              {!search && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSeedDemo}
                  disabled={seeding}
                  className="mt-3 gap-1.5 text-xs"
                >
                  <Sparkles className="size-3.5 text-amber-500" />
                  Create Sample Tables
                </Button>
              )}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredTables.map((table) => (
                <div
                  key={table.name}
                  className="flex flex-col rounded-xl border border-border bg-card shadow-xs transition-all hover:border-primary/50"
                >
                  {/* Table Card Header */}
                  <div className="flex items-center justify-between border-b px-4 py-3 bg-muted/20">
                    <div className="flex items-center gap-2">
                      <TableIcon className="size-4 text-primary" />
                      <span className="font-mono text-xs font-bold text-foreground">{table.name}</span>
                    </div>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      ~{table.estimatedRows.toLocaleString()} rows
                    </Badge>
                  </div>

                  {/* Columns List */}
                  <div className="divide-y divide-border/40 p-2 overflow-y-auto max-h-64">
                    {table.columns.map((col) => (
                      <div
                        key={col.name}
                        className="flex items-center justify-between py-1.5 px-2 text-xs hover:bg-muted/30 rounded-sm"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {col.isPrimaryKey ? (
                            <span title="Primary Key">
                              <Key className="size-3 text-amber-500 shrink-0" />
                            </span>
                          ) : col.references ? (
                            <span title={`Foreign Key references ${col.references.table}.${col.references.column}`}>
                              <Link2 className="size-3 text-sky-500 shrink-0" />
                            </span>
                          ) : (
                            <span className="size-3 shrink-0 rounded-full border border-border" />
                          )}
                          <span
                            className={`truncate font-mono text-xs ${
                              col.isPrimaryKey ? "font-semibold text-amber-500" : "text-foreground"
                            }`}
                          >
                            {col.name}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0 font-mono text-[11px]">
                          {col.references && (
                            <Badge
                              variant="secondary"
                              className="bg-sky-500/10 text-sky-500 border-sky-500/20 text-[9px] px-1 py-0"
                            >
                              → {col.references.table}
                            </Badge>
                          )}
                          <span className="text-muted-foreground">{col.type}</span>
                          {!col.nullable && <span className="text-[10px] text-muted-foreground/60">NN</span>}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Table Footer */}
                  <div className="mt-auto border-t px-4 py-2 font-mono text-[10px] text-muted-foreground flex justify-between">
                    <span>{table.columns.length} columns</span>
                    <span>{table.columns.filter((c) => c.isPrimaryKey).length ? "PK defined" : "No PK"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
