import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDashboardMetrics, usePoolPressure } from "@/hooks/use-backend";
import { AlertCard, PageHeader, Panel, Stat, chartTheme } from "@/components/common";
import { fmtMs, fmtNum, fmtTime, timeAgo, truncate } from "@/lib/format";
import { QueryVisualizer } from "@/components/QueryVisualizer";
import { simulatePlan } from "@/lib/plan";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — pg-router-ai" },
      { name: "description", content: "Live overview of query volume, latency, routing and anomalies across your PostgreSQL cluster." },
      { property: "og:title", content: "Dashboard — pg-router-ai" },
      { property: "og:description", content: "Live overview of query volume, latency, routing and anomalies across your PostgreSQL cluster." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { series, nodes, slow, alerts, live } = useDashboardMetrics();
  const poolPressure = usePoolPressure();
  const [drill, setDrill] = useState<string | null>(null);
  const last = series[series.length - 1] ?? {
    t: Date.now(),
    qps: 0,
    latency: 0,
    p95: 0,
    errorRate: 0,
    connections: 0,
    primaryPct: 0,
    lag1: 0,
    lag2: 0,
  };
  const conns = nodes.reduce((a, n) => a + n.connections, 0);
  const pie = nodes.map((n) => ({ name: n.id, value: n.queriesRouted }));
  const hasRouted = pie.some((p) => p.value > 0);
  const colors = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-4)"];
  const data = series.slice(-60).map((p) => ({ ...p, label: fmtTime(p.t) }));

  return (
    <>
      <PageHeader title="Cluster overview" sub={`${nodes.filter((n) => n.role === "primary").length} primary · ${nodes.filter((n) => n.role === "replica").length} replicas · ${live ? "live from backend" : "connecting to backend"}`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Connections" value={String(conns)} hint={`of ${nodes.reduce((a, n) => a + n.maxConnections, 0)} max`} />
        <Stat label="Queries / sec" value={fmtNum(last.qps)} hint="rolling 2s" />
        <Stat label="Avg latency" value={fmtMs(last.latency)} hint={`p95 ${fmtMs(last.p95)}`} tone={last.latency > 20 ? "warning" : undefined} />
        <Stat label="Error rate" value={`${last.errorRate.toFixed(2)}%`} tone={last.errorRate > 1 ? "destructive" : "success"} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Query volume" className="md:col-span-2">
          <div className="h-56">
            {data.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center font-mono text-xs text-muted-foreground">
                <span>Waiting for queries...</span>
                <span className="mt-1 text-[11px] text-muted-foreground/70">Execute a statement in Query Explorer to see real-time volume.</span>
              </div>
            ) : (
              <ResponsiveContainer>
                <AreaChart data={data}>
                  <defs>
                    <linearGradient id="qv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid stroke={chartTheme.grid} vertical={false} />
                  <XAxis dataKey="label" tick={chartTheme.axis} minTickGap={50} />
                  <YAxis tick={chartTheme.axis} width={40} />
                  <Tooltip contentStyle={chartTheme.tooltip} formatter={(v: number) => v.toFixed(0)} />
                  <Area type="monotone" dataKey="qps" stroke="var(--color-chart-1)" fill="url(#qv)" strokeWidth={2} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Panel>
        <Panel title="Routing distribution">
          <div className="h-56">
            {!hasRouted ? (
              <div className="flex h-full flex-col items-center justify-center font-mono text-xs text-muted-foreground">
                <span>No queries routed yet.</span>
                <span className="mt-1 text-[11px] text-muted-foreground/70">Traffic distribution across primary & replicas will appear here.</span>
              </div>
            ) : (
              <>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={pie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2} isAnimationActive={false}>
                      {pie.map((_, i) => <Cell key={i} fill={colors[i]} stroke="none" />)}
                    </Pie>
                    <Tooltip contentStyle={chartTheme.tooltip} formatter={(v: number) => fmtNum(v)} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex justify-center gap-4 font-mono text-xs">
                  {pie.map((p, i) => <span key={p.name} className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: colors[i] }} />{p.name}</span>)}
                </div>
              </>
            )}
          </div>
        </Panel>

        <Panel title="Recent slow queries" className="md:col-span-2" action={<span className="font-mono text-xs text-muted-foreground">click to see plan</span>}>
          <div className="overflow-x-auto">
            {slow.length === 0 ? (
              <div className="py-10 text-center font-mono text-xs text-muted-foreground">
                No slow queries recorded. Queries exceeding the slow query threshold will be captured here.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left font-mono text-[11px] uppercase text-muted-foreground">
                  <tr><th className="w-full pb-2 font-normal">Query</th><th className="pb-2 font-normal">Node</th><th className="pb-2 text-right font-normal">Duration</th><th className="pb-2 text-right font-normal">When</th></tr>
                </thead>
                <tbody>
                  {slow.slice(0, 7).map((q) => (
                    <tr key={q.id} className="cursor-pointer border-t hover:bg-muted/40" onClick={() => setDrill(q.sql)}>
                      <td className="max-w-0 truncate py-2 pr-3 font-mono text-xs">{truncate(q.sql, 90)}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{q.node}</td>
                      <td className={`py-2 text-right font-mono text-xs ${q.durationMs > 500 ? "text-destructive" : "text-warning"}`}>{fmtMs(q.durationMs)}</td>
                      <td className="py-2 pl-3 text-right font-mono text-xs text-muted-foreground whitespace-nowrap">{timeAgo(q.t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
        <Panel title="Active alerts" action={<Link to="/anomalies" className="text-xs text-primary hover:underline">View all</Link>}>
          <div className="space-y-2">
            {alerts.filter((a) => !a.acknowledged).length === 0 ? (
              <div className="py-10 text-center font-mono text-xs text-muted-foreground">
                All systems nominal · No active anomaly alerts.
              </div>
            ) : (
              alerts.filter((a) => !a.acknowledged).slice(0, 3).map((a) => <AlertCard key={a.id} alert={a} />)
            )}
          </div>
        </Panel>
      </div>

      {/* Connection Pooler & Circuit Breakers Panel */}
      <div className="mt-3">
        <Panel
          title="Connection Pooler & Circuit Breakers"
          action={
            <span className="font-mono text-xs text-muted-foreground">
              {poolPressure.nodes.length} nodes monitored · transaction-aware
            </span>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {poolPressure.nodes.map((node) => (
              <div key={node.nodeId} className="rounded-lg border bg-card p-3 shadow-xs">
                <div className="flex items-center justify-between border-b pb-2">
                  <div className="flex items-center gap-1.5 font-mono text-xs font-semibold">
                    <span className={`size-2 rounded-full ${node.healthy ? "bg-emerald-500" : "bg-rose-500"}`} />
                    <span>{node.nodeId}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {node.role}
                    </span>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                      node.circuitBreaker.state === "CLOSED"
                        ? "bg-emerald-500/15 text-emerald-500"
                        : node.circuitBreaker.state === "HALF_OPEN"
                        ? "bg-amber-500/15 text-amber-500"
                        : "bg-rose-500/15 text-rose-500"
                    }`}
                  >
                    CIRCUIT {node.circuitBreaker.state}
                  </span>
                </div>

                <div className="mt-3 space-y-2 font-mono text-xs">
                  <div>
                    <div className="flex justify-between text-[11px] text-muted-foreground">
                      <span>Pool Pressure</span>
                      <span>{node.connections.pressure}%</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full transition-all duration-300 ${
                          node.connections.pressure > 80
                            ? "bg-rose-500"
                            : node.connections.pressure > 50
                            ? "bg-amber-500"
                            : "bg-emerald-500"
                        }`}
                        style={{ width: `${Math.min(node.connections.pressure, 100)}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-1 rounded bg-muted/40 p-2 text-center text-[10px]">
                    <div>
                      <div className="text-muted-foreground">Active</div>
                      <div className="font-semibold">{node.connections.active}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Idle</div>
                      <div className="font-semibold">{node.connections.idle}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Waiting</div>
                      <div className="font-semibold">{node.connections.waiting}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Total</div>
                      <div className="font-semibold">{node.connections.total}</div>
                    </div>
                  </div>

                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>Response Time</span>
                    <span>{node.responseTimeMs >= 0 ? `${node.responseTimeMs.toFixed(1)}ms` : "unreachable"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Dialog open={!!drill} onOpenChange={(o) => !o && setDrill(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader><DialogTitle className="font-mono text-sm">{drill && truncate(drill, 100)}</DialogTitle></DialogHeader>
          {drill && <QueryVisualizer plan={simulatePlan(drill)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
