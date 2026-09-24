import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { flatten, type PlanNode } from "@/lib/plan";
import { fmtMs } from "@/lib/format";

const W = 190, H = 62, GX = 26, GY = 50;

interface Laid { node: PlanNode; x: number; y: number; parent?: Laid | undefined }

function layout(root: PlanNode, collapsed: Set<string>) {
  const out: Laid[] = [];
  let leaf = 0;
  const walk = (n: PlanNode, depth: number, parent?: Laid): Laid => {
    const kids = collapsed.has(n.id) ? [] : n.children;
    const me: Laid = { node: n, x: 0, y: depth * (H + GY), parent };
    out.push(me);
    if (!kids.length) me.x = leaf++ * (W + GX);
    else {
      const laid = kids.map((k) => walk(k, depth + 1, me));
      me.x = (laid[0]!.x + laid[laid.length - 1]!.x) / 2;
    }
    return me;
  };
  walk(root, 0);
  return out;
}

export function costColor(ratio: number) {
  // green -> yellow -> red by share of total time
  return ratio > 0.5 ? "var(--color-destructive)" : ratio > 0.2 ? "var(--color-warning)" : "var(--color-success)";
}

export function QueryVisualizer({ plan }: { plan: PlanNode }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<PlanNode>(plan);
  const [view, setView] = useState({ x: 20, y: 20, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => setSel(plan), [plan]);
  const nodes = useMemo(() => layout(plan, collapsed), [plan, collapsed]);
  const total = Math.max(0.001, plan.timeMs);
  const selfTime = (n: PlanNode) => Math.max(0, n.timeMs - n.children.reduce((a, c) => a + c.timeMs, 0));

  const zoomAt = (px: number, py: number, next: number) => {
    const v = viewRef.current;
    const k = Math.min(3, Math.max(0.3, next));
    const r = k / v.k;
    setView({ k, x: px - (px - v.x) * r, y: py - (py - v.y) * r });
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, viewRef.current.k * Math.exp(-dy * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const center = (f: number) => {
    const r = box.current!.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, viewRef.current.k * f);
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
      <div
        ref={box}
        className="relative h-[380px] cursor-grab touch-none overflow-hidden rounded-md border bg-background active:cursor-grabbing"
        onPointerDown={(e) => { drag.current = { x: e.clientX - view.x, y: e.clientY - view.y }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
        onPointerMove={(e) => drag.current && setView((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }))}
        onPointerUp={() => (drag.current = null)}
      >
        <svg className="size-full">
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {nodes.filter((l) => l.parent).map((l) => (
              <path key={`e${l.node.id}`} d={`M${l.parent!.x + W / 2},${l.parent!.y + H} C${l.parent!.x + W / 2},${l.y - GY / 2} ${l.x + W / 2},${l.parent!.y + H + GY / 2} ${l.x + W / 2},${l.y}`} fill="none" stroke="var(--color-border)" strokeWidth={Math.max(1, Math.log10(l.node.actualRows + 1) * 1.2)} />
            ))}
            {nodes.map((l) => {
              const ratio = selfTime(l.node) / total;
              const active = sel.id === l.node.id;
              return (
                <g key={l.node.id} transform={`translate(${l.x},${l.y})`} className="cursor-pointer" onPointerDown={(e) => e.stopPropagation()} onClick={() => setSel(l.node)} onDoubleClick={() => setCollapsed((s) => { const n = new Set(s); n.has(l.node.id) ? n.delete(l.node.id) : n.add(l.node.id); return n; })}>
                  <rect width={W} height={H} rx={6} fill="var(--color-card)" stroke={active ? "var(--color-primary)" : "var(--color-border)"} strokeWidth={active ? 2 : 1} />
                  <rect width={5} height={H} rx={2} fill={costColor(ratio)} />
                  <text x={14} y={20} fontSize={12} fontWeight={600} fill="var(--color-foreground)" fontFamily="var(--font-mono)">{l.node.type}{collapsed.has(l.node.id) && l.node.children.length ? ` [+${l.node.children.length}]` : ""}</text>
                  <text x={14} y={37} fontSize={10} fill="var(--color-muted-foreground)" fontFamily="var(--font-mono)">{l.node.relation ?? l.node.index ?? "—"}</text>
                  <text x={14} y={52} fontSize={10} fill="var(--color-muted-foreground)" fontFamily="var(--font-mono)">{fmtMs(l.node.timeMs)} · {l.node.actualRows.toLocaleString()} rows</text>
                  <text x={W - 8} y={20} fontSize={10} textAnchor="end" fill={costColor(ratio)} fontFamily="var(--font-mono)">{Math.round(ratio * 100)}%</text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="absolute right-2 top-2 flex gap-1">
          <Button size="icon" variant="secondary" className="size-7" onClick={() => center(1.25)} aria-label="Zoom in"><Plus className="size-3.5" /></Button>
          <Button size="icon" variant="secondary" className="size-7" onClick={() => center(0.8)} aria-label="Zoom out"><Minus className="size-3.5" /></Button>
          <Button size="icon" variant="secondary" className="size-7" onClick={() => setView({ x: 20, y: 20, k: 1 })} aria-label="Reset view"><Maximize2 className="size-3.5" /></Button>
        </div>
        <p className="absolute bottom-2 left-3 font-mono text-[10px] text-muted-foreground">drag to pan · scroll to zoom · double-click to collapse</p>
      </div>
      <NodeDetails node={sel} total={total} />
    </div>
  );
}

function NodeDetails({ node, total }: { node: PlanNode; total: number }) {
  const misest = node.estRows > 0 ? node.actualRows / node.estRows : 1;
  const rows: [string, string][] = [
    ["Relation", node.relation ?? "—"],
    ["Index", node.index ?? "none"],
    ["Actual rows", node.actualRows.toLocaleString()],
    ["Estimated rows", node.estRows.toLocaleString()],
    ["Estimate ratio", `${misest.toFixed(2)}×`],
    ["Total time", fmtMs(node.timeMs)],
    ["Share of query", `${Math.round((node.timeMs / total) * 100)}%`],
    ["Cost", node.cost.toFixed(1)],
  ];
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 font-mono text-sm font-semibold">{node.type}</div>
      <dl className="space-y-1.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono">{v}</dd></div>
        ))}
      </dl>
      {node.filter && <div className="mt-3 rounded bg-muted p-2 font-mono text-[11px] break-words">{node.filter}</div>}
      <div className="mt-3 text-[11px] text-muted-foreground">Heat by self-time: {flattenLegend}</div>
    </div>
  );
}
const flattenLegend = "green < 20% · yellow < 50% · red ≥ 50%";
export { flatten };
