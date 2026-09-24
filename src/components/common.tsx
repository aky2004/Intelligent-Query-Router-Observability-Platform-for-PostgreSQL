import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Alert, NodeStatus, Severity } from "@/lib/sim";
import { timeAgo, truncate } from "@/lib/format";

export function StatusDot({ status }: { status: NodeStatus }) {
  const c = status === "healthy" ? "bg-success" : status === "degraded" ? "bg-warning" : "bg-destructive";
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", c)} aria-label={status} />;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const c = severity === "critical" ? "bg-destructive/15 text-destructive border-destructive/30" : severity === "warning" ? "bg-warning/15 text-warning border-warning/30" : "bg-info/15 text-info border-info/30";
  return <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide", c)}>{severity}</span>;
}

export function PageHeader({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export function Panel({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-0 p-0", className)}>
      {title && (
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </Card>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string | undefined; tone?: "success" | "warning" | "destructive" | undefined }) {
  return (
    <Card className="gap-1 p-4">
      <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-2xl font-semibold tabular-nums", tone === "success" && "text-success", tone === "warning" && "text-warning", tone === "destructive" && "text-destructive")}>{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export function AlertCard({ alert, onAck, onInvestigate }: { alert: Alert; onAck?: () => void; onInvestigate?: () => void }) {
  return (
    <div className={cn("rounded-md border p-3", alert.acknowledged && "opacity-50")}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <SeverityBadge severity={alert.severity} />
        <span className="text-sm font-medium">{alert.reason}</span>
        <span className="font-mono text-xs text-muted-foreground">{alert.node}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{timeAgo(alert.t)}</span>
      </div>
      <code className="block truncate font-mono text-xs text-muted-foreground">{truncate(alert.query, 110)}</code>
      <div className="mt-2 flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">score {alert.score.toFixed(2)}</span>
        <div className="ml-auto flex gap-1.5">
          {onAck && !alert.acknowledged && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onAck}>Acknowledge</Button>}
          {onInvestigate && <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={onInvestigate}>Investigate</Button>}
        </div>
      </div>
    </div>
  );
}

export const chartTheme = {
  grid: "var(--color-border)",
  axis: { fontSize: 11, fill: "var(--color-muted-foreground)", fontFamily: "var(--font-mono)" },
  tooltip: { background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12, fontFamily: "var(--font-mono)" },
};
