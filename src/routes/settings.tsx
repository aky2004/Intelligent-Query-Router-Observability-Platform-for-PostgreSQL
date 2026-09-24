import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Trash2, Loader2, Plug } from "lucide-react";
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
const nodeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,32}$/, "Lowercase letters, numbers and dashes"),
  host: z.string().regex(/^[\w.-]+:\d{2,5}$/, "Use host:port"),
});

function Settings() {
  const thresholds = useSim((s) => s.thresholds);
  const nodes = useSim((s) => s.nodes);
  const connected = useSim((s) => s.connected);
  const [model, setModel] = useState("gemini-2.5-flash");
  const [embed, setEmbed] = useState("all-MiniLM-L6-v2");

  const live = useSim((s) => s.source === "live");
  const t = useForm({ resolver: zodResolver(thresholdSchema), defaultValues: thresholds });
  const n = useForm({ resolver: zodResolver(nodeSchema), defaultValues: { id: "", host: "" } });
  const [keys, setKeys] = useState<SettingsRes["ai"]["apiKeysConfigured"] | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState(() => getApiUrl());

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
    sim.setThresholds(v); // optimistic
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
  const addNode = async (v: { id: string; host: string }) => {
    if (nodes.some((x) => x.id === v.id)) return n.setError("id", { message: "Name already used" });
    const [host, port] = v.host.split(":");
    const node: DbNode = { id: v.id, host: v.host, role: "replica", status: "healthy", lagMs: 0, connections: 0, maxConnections: 150, latencyMs: 2, queriesRouted: 0 };
    sim.setNodes([...nodes, node]);
    if (live) {
      try {
        const r = await api<{ status: "connected" | "connection_failed" }>("/api/nodes", { method: "POST", json: { name: v.id, host, port: Number(port), role: "replica" } });
        if (r.status === "connection_failed") { sim.setNodes(sim.get().nodes.map((x) => (x.id === v.id ? { ...x, status: "down" } : x))); toast.warning(`${v.id} added but could not connect`); }
      } catch (e) { sim.setNodes(sim.get().nodes.filter((x) => x.id !== v.id)); return void toast.error(errorMessage(e)); }
    }
    n.reset(); toast.success(`Replica ${v.id} added`);
  };
  const removeNode = async (id: string) => {
    const prev = nodes;
    sim.setNodes(nodes.filter((x) => x.id !== id));
    if (live) { try { await api(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { sim.setNodes(prev); return void toast.error(errorMessage(e)); } }
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
  const saveUrl = async () => {
    if (url && !/^https?:\/\/.+/.test(url)) return void toast.error("Use a full address like https://api.example.com");
    setApiUrl(url);
    if (!url) { stopLive(); sim.hydrate({ source: "simulated", error: null, lastUpdated: null }); return void toast.success("Using simulated data"); }
    await retryLive();
    sim.get().source === "live" ? toast.success("Connected to backend") : toast.error(sim.get().error ?? "Could not connect");
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Backend connection" className="lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-backend.example.com (empty = simulated)" className="w-full font-mono sm:w-96" aria-label="Backend address" />
            <Button onClick={() => void saveUrl()}><Plug className="size-3.5" />Connect</Button>
            <span className="font-mono text-xs text-muted-foreground">{live ? "connected" : "not connected · simulated data"}</span>
          </div>
        </Panel>
        <Panel title="Database nodes" className="lg:col-span-2">
          <div className="space-y-2">
            {nodes.map((node) => (
              <div key={node.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                <StatusDot status={node.status} />
                <span className="font-mono text-sm">{node.id}</span>
                <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{node.host}</span>
                <span className="mr-auto rounded bg-muted px-1.5 font-mono text-[10px] uppercase">{node.role}</span>
                {node.role === "replica" && (
                  <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove ${node.id}`} onClick={() => void removeNode(node.id)}><Trash2 className="size-3.5" /></Button>
                )}
                {live && <Button size="sm" variant="ghost" className={`h-7 text-xs ${node.role === "primary" ? "ml-auto" : ""}`} disabled={testing === node.id} onClick={() => void testNode(node.id)}>{testing === node.id ? <Loader2 className="size-3 animate-spin" /> : null}Test</Button>}
              </div>
            ))}
          </div>
          <form className="mt-3 flex flex-wrap items-start gap-2" onSubmit={n.handleSubmit((v) => void addNode(v))}>
            <div><Input placeholder="replica-3" {...n.register("id")} className="w-40" /><p className="mt-1 text-xs text-destructive">{n.formState.errors.id?.message}</p></div>
            <div><Input placeholder="pg-replica-3.internal:5432" {...n.register("host")} className="w-64" /><p className="mt-1 text-xs text-destructive">{n.formState.errors.host?.message}</p></div>
            <Button type="submit" variant="secondary">Add replica</Button>
          </form>
        </Panel>

        <Panel title="Thresholds">
          <form className="space-y-3" onSubmit={t.handleSubmit((v) => void saveThresholds(v))}>
            {([["slowMs", "Slow query threshold (ms)"], ["lagMs", "Replica lag threshold (ms)"], ["window", "Anomaly detection window (queries)"]] as const).map(([k, label]) => (
              <div key={k}>
                <Label htmlFor={k} className="text-xs">{label}</Label>
                <Input id={k} type="number" className="mt-1 font-mono" {...t.register(k)} />
                <p className="mt-1 text-xs text-destructive">{t.formState.errors[k]?.message}</p>
              </div>
            ))}
            <div className="flex items-center gap-3"><Button type="submit" disabled={saving}>{saving && <Loader2 className="size-3.5 animate-spin" />}Save thresholds</Button>{dirty && <span className="font-mono text-xs text-warning">unsaved changes</span>}</div>
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
