import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2, Loader2, Database, Plus, ShieldCheck, AlertTriangle, Copy, Check, Code2, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Panel, StatusDot } from "@/components/common";
import { sim, useSim, type DbNode } from "@/lib/sim";
import { api, errorMessage, getApiUrl, setApiUrl } from "@/lib/api";
import { retryLive, stopLive } from "@/lib/live";

interface SettingsRes {
  nodes: { id: string; name: string; host: string; port: number; role: "primary" | "replica"; isActive: boolean }[];
  thresholds: { slowQueryMs: number; replicaLagMs: number; anomalyDetectionWindow: number };
  ai: { geminiModel: string; embeddingModel: string; apiKeysConfigured: { gemini: boolean; huggingface: boolean } };
}

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — pg-router-ai" },
      { name: "description", content: "Manage database nodes, AI models, alert thresholds and preferences." },
      { property: "og:title", content: "Settings — pg-router-ai" },
      { property: "og:description", content: "Manage database nodes, AI models, alert thresholds and preferences." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Settings,
});

const thresholdSchema = z.object({
  slowMs: z.coerce.number().int().min(1, "Must be at least 1").max(60000),
  lagMs: z.coerce.number().int().min(10, "Must be at least 10").max(600000),
  window: z.coerce.number().int().min(50, "Must be at least 50").max(100000),
});

/** Full PostgreSQL connection URL schema for onboarding */
const connectSchema = z.object({
  connectionString: z
    .string()
    .min(10, "Connection string is required")
    .refine(
      (s) => /^postgres(ql)?:\/\/.+/.test(s.trim()),
      "Must start with postgresql:// or postgres://"
    ),
  role: z.enum(["primary", "replica"]),
  name: z.string().optional(),
});

function deriveProxyUrl(connectionString: string | undefined): string {
  let hostname = "localhost";
  try {
    const apiBase = getApiUrl();
    if (apiBase) {
      const u = new URL(apiBase.startsWith("http") ? apiBase : `http://${apiBase}`);
      hostname = u.hostname;
    } else if (typeof window !== "undefined" && window.location.hostname) {
      hostname = window.location.hostname;
    }
  } catch {
    hostname = typeof window !== "undefined" && window.location.hostname ? window.location.hostname : "localhost";
  }

  // PG Wire Protocol TCP Proxy listens on port 5433
  const proxyHost = `${hostname}:5433`;

  if (!connectionString || !connectionString.trim()) {
    return `postgresql://<user>:<password>@${proxyHost}/neondb?sslmode=disable`;
  }

  const str = connectionString.trim();
  const m = str.match(/^postgres(?:ql)?:\/\/(?:([^:@\/]+)(?::([^@\/]+))?@)?([^:\/\?]+)(?::(\d+))?(?:\/([^?#]*))?(?:\?(.*))?$/i);
  if (!m) {
    return `postgresql://<user>:<password>@${proxyHost}/neondb?sslmode=disable`;
  }

  const user = m[1] || "<user>";
  const pass = m[2] ? `:${m[2]}` : "";
  const auth = user !== "<user>" || pass ? `${user}${pass}@` : "";
  const db = m[5] ? `/${m[5]}` : "/neondb";

  return `postgresql://${auth}${proxyHost}${db}?sslmode=disable`;
}

function Settings() {
  const thresholds = useSim((s) => s.thresholds);
  const nodes = useSim((s) => s.nodes);
  const connected = useSim((s) => s.connected);
  const [model, setModel] = useState("gemini-2.5-flash");
  const [embed, setEmbed] = useState("all-MiniLM-L6-v2");

  const live = useSim((s) => s.source === "live");
  const hasPrimary = nodes.some((n) => n.role === "primary");
  const primaryNode = nodes.find((n) => n.role === "primary");

  const t = useForm({ resolver: zodResolver(thresholdSchema), defaultValues: thresholds });

  // Controlled state for database connection form
  const [connStr, setConnStr] = useState("");
  const [nodeRole, setNodeRole] = useState<"primary" | "replica">("primary");
  const [nodeName, setNodeName] = useState("");
  const [connErr, setConnErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [keys, setKeys] = useState<SettingsRes["ai"]["apiKeysConfigured"] | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Automatically update default role when primary node status changes
  useEffect(() => {
    setNodeRole(hasPrimary ? "replica" : "primary");
  }, [hasPrimary]);

  // Load real config from the backend
  useEffect(() => {
    if (!live) return;
    api<SettingsRes>("/api/settings").then((r) => {
      const th = { slowMs: r.thresholds.slowQueryMs, lagMs: r.thresholds.replicaLagMs, window: r.thresholds.anomalyDetectionWindow };
      sim.setThresholds(th); t.reset(th);
      setModel(r.ai.geminiModel); setEmbed(r.ai.embeddingModel); setKeys(r.ai.apiKeysConfigured);
    }).catch((e) => toast.error(errorMessage(e)));
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unsaved-changes warning
  const dirty = t.formState.isDirty;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const saveThresholds = async (v: { slowMs: number; lagMs: number; window: number }) => {
    const prev = sim.get().thresholds;
    sim.setThresholds(v);
    if (live) {
      setSaving(true);
      try { await api("/api/settings/thresholds", { method: "PUT", json: { slowQueryMs: v.slowMs, replicaLagMs: v.lagMs, anomalyDetectionWindow: v.window } }); }
      catch (e) { sim.setThresholds(prev); setSaving(false); return void toast.error(errorMessage(e)); }
      setSaving(false);
    }
    t.reset(v); toast.success("Thresholds saved");
  };

  const saveAi = async (patch: { geminiModel?: string; embeddingModel?: string }) => {
    if (patch.geminiModel) setModel(patch.geminiModel);
    if (patch.embeddingModel) setEmbed(patch.embeddingModel);
    if (!live) return;
    try { await api("/api/settings/ai", { method: "PUT", json: { geminiModel: patch.geminiModel ?? model, embeddingModel: patch.embeddingModel ?? embed } }); toast.success("AI settings saved"); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  /** Connect a new database node via full PostgreSQL URL */
  const connectNode = async (v: { connectionString: string; role: "primary" | "replica"; name?: string | undefined }) => {
    setConnecting(true);
    const tempId = v.name || `${v.role}-${Date.now()}`;
    let connUrl = v.connectionString.trim();
    let host = tempId;
    try { host = new URL(connUrl).hostname; } catch { /* keep tempId */ }
    const optimistic: DbNode = { id: tempId, host, role: v.role, status: "healthy", lagMs: 0, connections: 0, maxConnections: v.role === "primary" ? 20 : 10, latencyMs: 0, queriesRouted: 0, connectionString: connUrl };
    sim.setNodes([...nodes, optimistic]);

    try {
      if (live) {
        const r = await api<{ node: DbNode; status: "connected" | "connection_failed"; error?: string }>("/api/nodes", {
          method: "POST",
          json: { connectionString: connUrl, role: v.role, name: v.name || undefined },
        });
        const realNode = r.node ? { ...r.node, connectionString: connUrl } : null;
        sim.setNodes([...sim.get().nodes.filter((n) => n.id !== tempId), ...(realNode ? [realNode] : [])]);
        if (r.status === "connection_failed") {
          toast.warning(`Node registered but health check failed: ${r.error ?? "connection failed"}`);
        } else {
          toast.success(`${v.role === "primary" ? "Primary database" : "Replica"} connected successfully`);
        }
      } else {
        toast.success(`${v.role === "primary" ? "Primary database" : "Replica"} added (simulated)`);
      }
      setConnStr("");
      setNodeName("");
    } catch (e) {
      sim.setNodes(sim.get().nodes.filter((n) => n.id !== tempId));
      toast.error(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const raw = connStr.trim();
    if (!raw) {
      setConnErr("Connection string is required");
      return;
    }
    if (!/^postgres(ql)?:\/\/.+/i.test(raw)) {
      setConnErr("Must start with postgresql:// or postgres://");
      return;
    }
    setConnErr(null);

    const cleanName = nodeName.trim();
    if (cleanName && !/^[a-z0-9-]{2,32}$/i.test(cleanName)) {
      setConnErr("Node name must be 2–32 lowercase letters, numbers, or dashes");
      return;
    }

    await connectNode({
      connectionString: raw,
      role: nodeRole,
      name: cleanName || undefined,
    });
  };

  const removeNode = async (id: string) => {
    const prev = nodes;
    sim.setNodes(nodes.filter((x) => x.id !== id));
    if (live) {
      try { await api(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }); }
      catch (e) { sim.setNodes(prev); return void toast.error(errorMessage(e)); }
    }
    toast.success(`${id} removed`);
  };

  const testNode = async (id: string) => {
    setTesting(id);
    try {
      const r = await api<{ status: "success" | "failed"; error?: string; latencyMs: number }>(`/api/nodes/${encodeURIComponent(id)}/test`, { method: "POST", retries: 1 });
      r.status === "success" ? toast.success(`${id} reachable · ${r.latencyMs}ms`) : toast.error(`${id}: ${r.error ?? "connection failed"}`);
    } catch (e) { toast.error(errorMessage(e)); } finally { setTesting(null); }
  };

  const toggleLive = async (enabled: boolean) => {
    sim.setConnected(enabled);
    if (live) await api("/api/settings/live-updates", { method: "PUT", json: { enabled } }).catch((e) => { sim.setConnected(!enabled); toast.error(errorMessage(e)); });
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── Database Nodes ── */}
        <Panel title="Database nodes" className="lg:col-span-2">

          {/* Empty-state banner when no nodes are configured */}
          {nodes.length === 0 && (
            <div className="mb-4 flex items-start gap-3 rounded-lg border border-dashed border-warning/50 bg-warning/5 p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
              <div>
                <p className="text-sm font-medium">No database connected</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Paste your PostgreSQL connection URL below to start routing and monitoring your database traffic.
                </p>
              </div>
            </div>
          )}

          {/* Connected nodes list */}
          {nodes.length > 0 && (
            <div className="mb-4 space-y-2">
              {nodes.map((node) => (
                <div key={node.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <StatusDot status={node.status} />
                  <Database className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-sm">{node.id}</span>
                  <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{node.host}</span>
                  <span className={`mr-auto rounded px-1.5 font-mono text-[10px] uppercase ${node.role === "primary" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                    {node.role}
                  </span>
                  {live && (
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" disabled={testing === node.id} onClick={() => void testNode(node.id)}>
                      {testing === node.id ? <Loader2 className="size-3 animate-spin" /> : null}Test
                    </Button>
                  )}
                  <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" aria-label={`Remove ${node.id}`} onClick={() => void removeNode(node.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Connect-your-database form */}
          <form
            id="connect-db-form"
            className="space-y-3 rounded-lg border bg-muted/20 p-4"
            onSubmit={(e) => void handleConnectSubmit(e)}
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" />
              <span className="text-sm font-medium">{hasPrimary ? "Add a replica" : "Connect your database"}</span>
            </div>

            <div>
              <Label htmlFor="db-conn-url" className="text-xs">
                PostgreSQL connection URL
              </Label>
              <Input
                id="db-conn-url"
                value={connStr}
                onChange={(e) => {
                  setConnStr(e.target.value);
                  if (connErr) setConnErr(null);
                }}
                placeholder="postgresql://user:password@host:5432/dbname?sslmode=require"
                className="mt-1 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              {connErr && (
                <p className="mt-1 text-xs text-destructive">{connErr}</p>
              )}
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Your connection string is sent securely to the backend and never stored in the browser.
              </p>
            </div>

            <div className="flex flex-wrap items-start gap-3">
              <div className="flex-1">
                <Label htmlFor="db-node-role" className="text-xs">Role</Label>
                <Select value={nodeRole} onValueChange={(v) => setNodeRole(v as "primary" | "replica")}>
                  <SelectTrigger id="db-node-role" className="mt-1 h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary" disabled={hasPrimary}>
                      Primary {hasPrimary ? "(already connected)" : ""}
                    </SelectItem>
                    <SelectItem value="replica">Replica / Read replica</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1">
                <Label htmlFor="db-node-name" className="text-xs">Node name <span className="text-muted-foreground">(optional)</span></Label>
                <Input
                  id="db-node-name"
                  value={nodeName}
                  onChange={(e) => setNodeName(e.target.value)}
                  placeholder={nodeRole === "primary" ? "primary" : "replica-2"}
                  className="mt-1 h-9 font-mono text-xs"
                />
              </div>
            </div>

            <Button type="submit" disabled={connecting} className="w-full sm:w-auto">
              {connecting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {connecting ? "Connecting…" : hasPrimary ? "Add replica" : "Connect primary database"}
            </Button>
          </form>

          {/* Dynamic Project Integration Setup Guide */}
          <div className="mt-4 rounded-lg border border-primary/25 bg-primary/5 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Code2 className="size-4 text-primary" />
                <span className="text-sm font-semibold">How to use pg-router-ai in your project</span>
              </div>
              <span className="rounded bg-primary/15 px-2 py-0.5 font-mono text-[10px] font-medium text-primary uppercase">
                {hasPrimary ? "⚡ Interceptor Active" : "ℹ️ Setup Guide"}
              </span>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed">
              {hasPrimary
                ? "Your primary database is connected! You can execute queries through pg-router-ai using the Query Router API or by setting your project's DATABASE_URL string:"
                : "Once your database is connected, execute queries through pg-router-ai to enable automatic read/write routing, load balancing, and AI query optimization:"}
            </p>

            {/* Option 1: HTTP API Query Execution */}
            <div className="relative rounded-md border bg-card p-3 font-mono text-xs space-y-2">
              <div className="flex items-center justify-between border-b pb-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Terminal className="size-3.5 text-primary" />
                  <span>Option 1: HTTP Router API (Recommended)</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px] hover:bg-muted"
                  onClick={() => {
                    const sample = `POST ${getApiUrl() || "http://localhost:3000"}/api/query\nContent-Type: application/json\n\n{\n  "sql": "SELECT * FROM users WHERE id = $1",\n  "params": [1]\n}`;
                    navigator.clipboard.writeText(sample);
                    setCopied(true);
                    toast.success("Query API request snippet copied!");
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                  {copied ? "Copied!" : "Copy API Request"}
                </Button>
              </div>
              <div className="overflow-x-auto text-primary font-semibold select-all py-0.5">
                POST {getApiUrl() || "http://localhost:3000"}/api/query
              </div>
            </div>

            {/* Option 2: Proxy Connection String */}
            <div className="relative rounded-md border bg-card p-3 font-mono text-xs space-y-2">
              <div className="flex items-center justify-between border-b pb-1.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Terminal className="size-3.5 text-primary" />
                  <span>Option 2: Connection String (.env)</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1.5 px-2 text-[11px] hover:bg-muted"
                  onClick={() => {
                    const sample = `DATABASE_URL="${deriveProxyUrl(primaryNode?.connectionString || connStr)}"`;
                    navigator.clipboard.writeText(sample);
                    setCopied(true);
                    toast.success("Proxy DATABASE_URL copied to clipboard!");
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                  {copied ? "Copied!" : "Copy DATABASE_URL"}
                </Button>
              </div>

              <div className="overflow-x-auto text-primary font-semibold select-all py-0.5">
                DATABASE_URL="{deriveProxyUrl(primaryNode?.connectionString || connStr)}"
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/40 gap-2">
              <span>Automatic Features: Smart Read/Write Splitting · Circuit-Breaker Failover · Real-Time Metrics & Anomaly Detection</span>
            </div>
          </div>
        </Panel>

        <Panel title="Thresholds">
          <form className="space-y-3" onSubmit={t.handleSubmit((v) => void saveThresholds(v))}>
            {([ ["slowMs", "Slow query threshold (ms)"], ["lagMs", "Replica lag threshold (ms)"], ["window", "Anomaly detection window (queries)"] ] as const).map(([k, label]) => (
              <div key={k}>
                <Label htmlFor={k} className="text-xs">{label}</Label>
                <Input id={k} type="number" className="mt-1 font-mono" {...t.register(k)} />
                <p className="mt-1 text-xs text-destructive">{t.formState.errors[k]?.message}</p>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>{saving && <Loader2 className="size-3.5 animate-spin" />}Save thresholds</Button>
              {dirty && <span className="font-mono text-xs text-warning">unsaved changes</span>}
            </div>
          </form>
        </Panel>

        <div className="space-y-3">
          <Panel title="AI models">
            <div className="space-y-3">
              <div><Label className="text-xs">Query optimizer</Label>
                <Select value={model} onValueChange={(v) => void saveAi({ geminiModel: v })}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="gemini-2.5-flash">Gemini 2.5 Flash</SelectItem><SelectItem value="gemini-2.5-pro">Gemini 2.5 Pro</SelectItem><SelectItem value="heuristic">Heuristic only (no AI)</SelectItem></SelectContent></Select>
              </div>
              <div><Label className="text-xs">Anomaly embeddings</Label>
                <Select value={embed} onValueChange={(v) => void saveAi({ embeddingModel: v })}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all-MiniLM-L6-v2">all-MiniLM-L6-v2</SelectItem><SelectItem value="bge-small-en">bge-small-en</SelectItem><SelectItem value="local-hash">Local hash (offline)</SelectItem></SelectContent></Select>
              </div>
              {keys && <p className="font-mono text-xs text-muted-foreground">Keys (set on the server): Gemini {keys.gemini ? "✓" : "✗"} · Hugging Face {keys.huggingface ? "✓" : "✗"}</p>}
            </div>
          </Panel>
          <Panel title="Preferences">
            <div className="flex items-center justify-between">
              <div><div className="text-sm">Live updates</div><div className="text-xs text-muted-foreground">Stream metrics and alerts every 2 seconds</div></div>
              <Switch checked={connected} onCheckedChange={(v) => void toggleLive(v)} />
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

