import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSim } from "@/lib/sim";
import { applyTimeseries, endpoints } from "@/lib/live";
import { PageHeader, Panel, StatusDot, chartTheme } from "@/components/common";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Progress } from "@/components/ui/progress";
import { fmtMs, fmtNum, fmtTime } from "@/lib/format";

export const Route = createFileRoute("/metrics")({
  head: () => ({
    meta: [
      { title: "Metrics — pg-router-ai" },
      { name: "description", content: "Time-series throughput, latency, errors, node health and replica lag." },
      { property: "og:title", content: "Metrics — pg-router-ai" },
      { property: "og:description", content: "Time-series throughput, latency, errors, node health and replica lag." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Metrics,
});

const RANGES = { "1m": 30, "3m": 90, "6m": 180 } as const;

function Chart({ data, lines, unit, ref: refLine }: { data: object[]; lines: { key: string; color: string; name: string }[]; unit?: string; ref?: number }) {
  return (
    <div className="h-48">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid stroke={chartTheme.grid} vertical={false} />
          <XAxis dataKey="label" tick={chartTheme.axis} minTickGap={50} />
          <YAxis tick={chartTheme.axis} width={44} />
          <Tooltip contentStyle={chartTheme.tooltip} formatter={(v: number) => `${v.toFixed(1)}${unit ?? ""}`} />
          {refLine !== undefined && <ReferenceLine y={refLine} stroke="var(--color-destructive)" strokeDasharray="4 4" />}
          {lines.map((l) => <Line key={l.key} dataKey={l.key} name={l.name} stroke={l.color} dot={false} strokeWidth={2} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Metrics() {
  const [range, setRange] = useState<keyof typeof RANGES>("3m");
  const series = useSim((s) => s.series);
  const nodes = useSim((s) => s.nodes);
  const lagMax = useSim((s) => s.thresholds.lagMs);
  const live = useSim((s) => s.source === "live");
  useEffect(() => {
    if (!live) return;
    const end = Date.now();
    endpoints.timeseries(end - RANGES[range] * 2000, end, "2s").then(applyTimeseries).catch(() => {});
  }, [range, live]);
  const data = series.slice(-RANGES[range]).map((p) => ({ ...p, label: fmtTime(p.t) }));

  return (
    <>
      <PageHeader title="Metrics" sub="Live time-series from the router">
        <ToggleGroup type="single" variant="outline" size="sm" value={range} onValueChange={(v) => v && setRange(v as keyof typeof RANGES)}>
          {Object.keys(RANGES).map((r) => <ToggleGroupItem key={r} value={r} className="font-mono text-xs">{r}</ToggleGroupItem>)}
        </ToggleGroup>
      </PageHeader>

      <div className="mb-3 grid gap-3 md:grid-cols-3">
        {nodes.map((n) => (
          <Panel key={n.id}>
            <div className="mb-3 flex items-center gap-2">
              <StatusDot status={n.status} />
              <span className="font-mono text-sm font-semibold">{n.id}</span>
              <span className="rounded bg-muted px-1.5 font-mono text-[10px] uppercase text-muted-foreground">{n.role}</span>
              <span className="ml-auto text-xs capitalize text-muted-foreground">{n.status}</span>
            </div>
            <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">Pool</span><span className="font-mono">{n.connections}/{n.maxConnections}</span></div>
            <Progress value={(n.connections / n.maxConnections) * 100} className="h-1.5" />
            <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-xs">
              <div><dt className="text-muted-foreground">latency</dt><dd>{fmtMs(n.latencyMs)}</dd></div>
              <div><dt className="text-muted-foreground">lag</dt><dd className={n.lagMs > lagMax ? "text-warning" : ""}>{n.role === "primary" ? "—" : fmtMs(n.lagMs)}</dd></div>
              <div><dt className="text-muted-foreground">routed</dt><dd>{fmtNum(n.queriesRouted)}</dd></div>
            </dl>
          </Panel>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Throughput (qps)"><Chart data={data} lines={[{ key: "qps", color: "var(--color-chart-1)", name: "qps" }]} /></Panel>
        <Panel title="Latency"><Chart data={data} unit="ms" lines={[{ key: "latency", color: "var(--color-chart-2)", name: "avg" }, { key: "p95", color: "var(--color-chart-3)", name: "p95" }]} /></Panel>
        <Panel title="Replica lag" action={<span className="font-mono text-xs text-muted-foreground">threshold {lagMax}ms</span>}><Chart data={data} unit="ms" ref={lagMax} lines={[{ key: "lag1", color: "var(--color-chart-4)", name: "replica-1" }, { key: "lag2", color: "var(--color-chart-2)", name: "replica-2" }]} /></Panel>
        <Panel title="Error rate & primary share"><Chart data={data} unit="%" lines={[{ key: "errorRate", color: "var(--color-chart-5)", name: "errors" }, { key: "primaryPct", color: "var(--color-chart-1)", name: "primary share" }]} /></Panel>
      </div>
    </>
  );
}
