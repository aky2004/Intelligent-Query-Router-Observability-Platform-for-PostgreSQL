import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSim, sim, type Severity } from "@/lib/sim";
import { AlertCard, PageHeader, Panel, chartTheme } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryVisualizer } from "@/components/QueryVisualizer";
import { simulatePlan } from "@/lib/plan";
import { toast } from "sonner";
import { endpoints } from "@/lib/live";
import { errorMessage } from "@/lib/api";

export const Route = createFileRoute("/anomalies")({
  head: () => ({
    meta: [
      { title: "Anomalies — pg-router-ai" },
      { name: "description", content: "Real-time ML-detected query anomalies: N+1 patterns, volume spikes and new query shapes." },
      { property: "og:title", content: "Anomalies — pg-router-ai" },
      { property: "og:description", content: "Real-time ML-detected query anomalies: N+1 patterns, volume spikes and new query shapes." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  validateSearch: (s: Record<string, unknown>): { severity?: Severity } =>
    s["severity"] === "critical" || s["severity"] === "warning" || s["severity"] === "info" ? { severity: s["severity"] } : {},
  component: Anomalies,
});

const RANGE_MS = { "1h": 3.6e6, "6h": 2.16e7, "24h": 8.64e7 } as const;

function Anomalies() {
  const alerts = useSim((s) => s.alerts);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const sev: "all" | Severity = search.severity ?? "all";
  const setSev = (v: "all" | Severity) => void navigate({ search: v === "all" ? {} : { severity: v }, replace: true });
  const acknowledge = async (id: string) => {
    sim.acknowledge(id); // optimistic
    if (sim.get().source !== "live") return;
    try { await endpoints.acknowledge(id); } catch (e) {
      sim.hydrate({ alerts: sim.get().alerts.map((a) => (a.id === id ? { ...a, acknowledged: false } : a)) });
      toast.error(errorMessage(e));
    }
  };
  const [node, setNode] = useState("all");
  const [range, setRange] = useState<keyof typeof RANGE_MS>("24h");
  const [q, setQ] = useState("");
  const [inv, setInv] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const since = Date.now() - RANGE_MS[range];
    return alerts.filter((a) => a.t >= since && (sev === "all" || a.severity === sev) && (node === "all" || a.node === node) && (!q || (a.query + a.reason).toLowerCase().includes(q.toLowerCase())));
  }, [alerts, sev, node, range, q]);

  const byReason = useMemo(() => {
    const m: Record<string, number> = {};
    filtered.forEach((a) => (m[a.reason] = (m[a.reason] ?? 0) + 1));
    return Object.entries(m).map(([reason, count]) => ({ reason, count }));
  }, [filtered]);
  const trend = useMemo(() => {
    const buckets = 12, span = RANGE_MS[range] / buckets, now = Date.now();
    return Array.from({ length: buckets }, (_, i) => {
      const start = now - (buckets - i) * span;
      const inB = filtered.filter((a) => a.t >= start && a.t < start + span);
      return { label: `-${Math.round(((buckets - i) * span) / 60000)}m`, critical: inB.filter((a) => a.severity === "critical").length, other: inB.filter((a) => a.severity !== "critical").length };
    });
  }, [filtered, range]);

  return (
    <>
      <PageHeader title="Anomaly detection" sub="Embedding-based pattern scoring over a sliding window of 1000 queries" />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Search query text…" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-64" />
        <Select value={sev} onValueChange={(v) => setSev(v as typeof sev)}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All severities</SelectItem><SelectItem value="critical">Critical</SelectItem><SelectItem value="warning">Warning</SelectItem><SelectItem value="info">Info</SelectItem></SelectContent>
        </Select>
        <Select value={node} onValueChange={setNode}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All nodes</SelectItem>{["primary", "replica-1", "replica-2"].map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={range} onValueChange={(v) => setRange(v as typeof range)}>
          <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.keys(RANGE_MS).map((r) => <SelectItem key={r} value={r}>Last {r}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_380px]">
        <Panel title={`Alert feed · ${filtered.length}`}>
          <div className="max-h-[640px] space-y-2 overflow-auto pr-1">
            {filtered.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No anomalies match these filters.</p>}
            {filtered.slice(0, 100).map((a) => <AlertCard key={a.id} alert={a} onAck={() => void acknowledge(a.id)} onInvestigate={() => setInv(a.query)} />)}
          </div>
        </Panel>
        <div className="space-y-3">
          <Panel title="Frequency">
            <div className="h-40"><ResponsiveContainer><BarChart data={trend}><CartesianGrid stroke={chartTheme.grid} vertical={false} /><XAxis dataKey="label" tick={chartTheme.axis} minTickGap={20} /><YAxis tick={chartTheme.axis} width={24} allowDecimals={false} /><Tooltip contentStyle={chartTheme.tooltip} /><Bar dataKey="critical" stackId="a" fill="var(--color-destructive)" /><Bar dataKey="other" stackId="a" fill="var(--color-warning)" /></BarChart></ResponsiveContainer></div>
          </Panel>
          <Panel title="Patterns">
            <div className="h-48"><ResponsiveContainer><BarChart data={byReason} layout="vertical"><XAxis type="number" tick={chartTheme.axis} allowDecimals={false} /><YAxis type="category" dataKey="reason" tick={chartTheme.axis} width={96} /><Tooltip contentStyle={chartTheme.tooltip} /><Bar dataKey="count" fill="var(--color-chart-1)" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>
          </Panel>
        </div>
      </div>

      <Dialog open={!!inv} onOpenChange={(o) => !o && setInv(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader><DialogTitle className="font-mono text-sm">{inv}</DialogTitle></DialogHeader>
          {inv && <QueryVisualizer plan={simulatePlan(inv)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
