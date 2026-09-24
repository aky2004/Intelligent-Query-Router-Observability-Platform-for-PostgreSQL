import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Play, FileSearch, Sparkles, Check, History, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, Panel } from "@/components/common";
import { QueryVisualizer } from "@/components/QueryVisualizer";
import { parseExplainJson, analyze, routeFor, simulatePlan, simulateRows, type PlanNode, type Suggestion } from "@/lib/plan";
import { fmtMs, fmtTime } from "@/lib/format";
import { sim, useSim } from "@/lib/sim";
import { api, errorMessage } from "@/lib/api";
import { socketService } from "@/lib/socket";
import { useAIAnalysis, useAction } from "@/hooks/use-backend";
import { Input } from "@/components/ui/input";
import { Loader2, Wand2 } from "lucide-react";

function toPlan(raw: unknown, sql: string): PlanNode {
  if (!raw) return simulatePlan(sql);
  try { return parseExplainJson(raw); } catch { return (raw as PlanNode).type ? (raw as PlanNode) : simulatePlan(sql); }
}
const ROOM = "query-editor-default";
interface ExecRes { results: Record<string, unknown>[]; rowCount: number; executionTime: string; routedTo: string; queryPlan?: unknown }
interface HistoryRes { queries: { id: string; sql: string; executedAt: string; duration: number | string; status: string }[] }

export const Route = createFileRoute("/explorer")({
  head: () => ({
    meta: [
      { title: "Query Explorer — pg-router-ai" },
      { name: "description", content: "Collaborative SQL editor with routing preview, execution plans and AI optimization suggestions." },
      { property: "og:title", content: "Query Explorer — pg-router-ai" },
      { property: "og:description", content: "Collaborative SQL editor with routing preview, execution plans and AI optimization suggestions." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Explorer,
});

const COLORS = ["var(--color-chart-1)", "var(--color-chart-2)", "var(--color-chart-3)", "var(--color-chart-4)", "var(--color-chart-5)"];
const NAMES = ["Otter", "Heron", "Lynx", "Falcon", "Badger", "Marten"];
interface Peer { id: string; name: string; color: string; pos: number; seen: number }
interface Version { t: number; sql: string; by: string }

// Real-time collaboration across tabs/windows of this browser via BroadcastChannel.
function useCollab(initial: string) {
  const [text, setText] = useState(initial);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [versions, setVersions] = useState<Version[]>([]);
  const [me, setMe] = useState<Peer | null>(null);
  const ch = useRef<BroadcastChannel | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    const i = Math.floor(Math.random() * NAMES.length);
    const self: Peer = { id: Math.random().toString(36).slice(2), name: NAMES[i]!, color: COLORS[i % COLORS.length]!, pos: 0, seen: Date.now() };
    setMe(self);
    const c = new BroadcastChannel("pg-router-editor");
    ch.current = c;
    c.onmessage = (e) => {
      const m = e.data;
      if (m.type === "edit") setText(m.text);
      if (m.type === "hello") c.postMessage({ type: "edit", text: textRef.current });
      if (m.type === "presence" || m.type === "hello") setPeers((p) => ({ ...p, [m.peer.id]: { ...m.peer, seen: Date.now() } }));
      if (m.type === "bye") setPeers((p) => { const n = { ...p }; delete n[m.id]; return n; });
    };
    c.postMessage({ type: "hello", peer: self });
    // Cross-machine collaboration through the backend when connected.
    socketService.emit("editor:join", { room: ROOM, user: self });
    const offs = [
      socketService.subscribe("editor:sync", (m: { room: string; text: string; from: string }) => m.room === ROOM && m.from !== self.id && setText(m.text)),
      socketService.subscribe("cursor:update", (m: { room: string; peer: Peer }) => m.room === ROOM && m.peer.id !== self.id && setPeers((p) => ({ ...p, [m.peer.id]: { ...m.peer, seen: Date.now() } }))),
      socketService.subscribe("user:joined", (m: { room: string; user: Peer }) => m.room === ROOM && m.user.id !== self.id && setPeers((p) => ({ ...p, [m.user.id]: { ...m.user, seen: Date.now() } }))),
      socketService.subscribe("user:left", (m: { room: string; userId: string }) => m.room === ROOM && setPeers((p) => { const n = { ...p }; delete n[m.userId]; return n; })),
    ];
    const hb = setInterval(() => {
      c.postMessage({ type: "presence", peer: self });
      setPeers((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => Date.now() - v.seen < 6000)));
    }, 2000);
    const snap = setInterval(() => setVersions((v) => (v[0]?.sql === textRef.current ? v : [{ t: Date.now(), sql: textRef.current, by: self.name }, ...v].slice(0, 20))), 30000);
    const bye = () => c.postMessage({ type: "bye", id: self.id });
    window.addEventListener("beforeunload", bye);
    return () => { offs.forEach((o) => o()); socketService.emit("editor:leave", { room: ROOM, userId: self.id }); bye(); clearInterval(hb); clearInterval(snap); window.removeEventListener("beforeunload", bye); c.close(); };
  }, []);

  const update = (t: string, pos: number) => {
    setText(t);
    ch.current?.postMessage({ type: "edit", text: t });
    if (me) socketService.emit("editor:sync", { room: ROOM, text: t, from: me.id });
    if (me) { me.pos = pos; ch.current?.postMessage({ type: "presence", peer: me }); socketService.emit("cursor:update", { room: ROOM, peer: me }); }
  };
  const snapshot = () => me && setVersions((v) => [{ t: Date.now(), sql: textRef.current, by: me.name }, ...v].slice(0, 20));
  return { text, update, peers: Object.values(peers), me, versions, snapshot, setText: (t: string) => update(t, 0) };
}

const KEYWORDS = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|ON|GROUP|BY|ORDER|LIMIT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|AND|OR|AS|COUNT|DESC|ASC|LIKE|NOT|NULL|IN|BEGIN|COMMIT|WITH|INTERVAL|HAVING)\b/gi;
function highlight(sql: string) {
  const esc = sql.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return esc
    .replace(/('[^']*')/g, '<span class="text-success">$1</span>')
    .replace(/(\$\d+)/g, '<span class="text-warning">$1</span>')
    .replace(KEYWORDS, '<span class="text-primary font-semibold">$1</span>') + "\n";
}

interface Result { columns: string[]; rows: Record<string, unknown>[]; node: string; reason: string; ms: number; plan?: PlanNode; messages: string[] }

function Explorer() {
  const collab = useCollab(sim.sampleQueries[0]! + ";");
  const [result, setResult] = useState<Result | null>(null);
  const [tab, setTab] = useState("results");
  const [running, setRunning] = useState(false);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState<Suggestion | null>(null);
  const route = useMemo(() => routeFor(collab.text), [collab.text]);
  const live = useSim((st) => st.source === "live");
  const remote = useAIAnalysis(live ? collab.text : "", result?.ms);
  const local = useMemo(() => analyze(collab.text, result?.plan ?? simulatePlan(collab.text)), [collab.text, result?.plan]);
  const suggestions: Suggestion[] = remote.data
    ? remote.data.map((r, i) => ({ id: `ai-${i}-${r.type}`, kind: r.type, title: r.type.replace(/_/g, " ").toLowerCase(), detail: r.message, confidence: r.confidence, improvement: parseFloat(r.estimatedImprovement ?? "0") || 0, ...(r.sql ? { sql: r.sql } : {}) }))
    : local;
  const [nl, setNl] = useState("");
  const convert = useAction(async () => {
    const r = await api<{ sql: string; confidence: number; explanation: string }>("/api/ai/convert", { method: "POST", json: { naturalLanguage: nl } });
    collab.setText(r.sql);
    toast.success(`SQL generated (${Math.round(r.confidence * 100)}% confidence)`, { description: r.explanation });
  });
  const [history, setHistory] = useState<HistoryRes["queries"]>([]);
  const loadHistory = () => api<HistoryRes>("/api/queries/history?limit=50", { retries: 1 }).then((r) => setHistory(r.queries)).catch(() => {});
  useEffect(() => { if (live) void loadHistory(); }, [live]);

  const runRemote = async (explain: boolean) => {
    setRunning(true);
    try {
      const r = await api<ExecRes>("/api/query/execute", { method: "POST", json: { sql: collab.text, useExplain: explain, targetNode: "auto" } });
      const rows = r.results ?? [];
      const columns = rows[0] ? Object.keys(rows[0]) : ["rows_affected"];
      setResult({
        columns, rows: rows.length ? rows : [{ rows_affected: r.rowCount }], node: r.routedTo, reason: "routed by backend",
        ms: parseFloat(r.executionTime) || 0, plan: toPlan(r.queryPlan, collab.text),
        messages: [`[${fmtTime(Date.now())}] routed to ${r.routedTo}`, `[${fmtTime(Date.now())}] ${r.rowCount} rows · ${r.executionTime}`],
      });
      setTab(explain ? "plan" : "results");
      void loadHistory();
    } catch (e) {
      toast.error(errorMessage(e), { action: { label: "Retry", onClick: () => void runRemote(explain) } });
    } finally { setRunning(false); }
  };

  const run = (explain: boolean) => {
    if (live) return void runRemote(explain);
    setRunning(true);
    const t0 = performance.now();
    setTimeout(() => {
      const r = routeFor(collab.text);
      const plan = simulatePlan(collab.text);
      const isSelect = /^\s*select/i.test(collab.text);
      const data = isSelect ? simulateRows(collab.text) : { columns: ["rows_affected"], rows: [{ rows_affected: 1 }] };
      setResult({ ...data, node: r.target, reason: r.reason, ms: plan.timeMs + (performance.now() - t0), plan, messages: [`[${fmtTime(Date.now())}] routed to ${r.target} — ${r.reason}`, `[${fmtTime(Date.now())}] ${isSelect ? `${data.rows.length} rows returned` : "1 row affected"}`] });
      setTab(explain ? "plan" : "results");
      setRunning(false);
    }, 250 + Math.random() * 300);
  };

  return (
    <>
      <PageHeader title="Query Explorer" sub="Edit together in real time — open this page in another tab to collaborate.">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-muted-foreground" />
          {[collab.me, ...collab.peers].filter(Boolean).map((p) => (
            <span key={p!.id} title={p!.name} className="grid size-7 place-items-center rounded-full border-2 border-background font-mono text-[11px] font-semibold text-primary-foreground" style={{ background: p!.color }}>{p!.name[0]}</span>
          ))}
        </div>
      </PageHeader>

      <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
        <div className="grid min-w-0 gap-3 lg:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <Panel title="Editor" action={<span className="font-mono text-xs">→ <span className={route.target === "primary" ? "text-warning" : "text-success"}>{route.target === "primary" ? "primary" : "replica"}</span></span>}>
            <div className="relative h-56 overflow-hidden rounded-md border bg-background font-mono text-sm leading-6">
              <pre aria-hidden className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-3" dangerouslySetInnerHTML={{ __html: highlight(collab.text) }} />
              <textarea
                spellCheck={false}
                value={collab.text}
                onChange={(e) => collab.update(e.target.value, e.target.selectionStart)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(false); }}
                className="absolute inset-0 size-full resize-none whitespace-pre-wrap break-words bg-transparent p-3 text-transparent caret-foreground outline-none"
                aria-label="SQL editor"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => run(false)} disabled={running}>{running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}Run</Button>
              <Button size="sm" variant="secondary" onClick={() => run(true)} disabled={running}><FileSearch className="size-3.5" />Explain analyze</Button>
              <Button size="sm" variant="ghost" onClick={() => { collab.snapshot(); toast.success("Version saved"); }}><History className="size-3.5" />Save version</Button>
              <span className="ml-auto text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
            </div>
            {live && (
              <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (nl.trim()) void convert.run(); }}>
                <Input value={nl} onChange={(e) => setNl(e.target.value)} placeholder="Describe a query in plain English…" className="h-8 font-mono text-xs" aria-label="Natural language query" />
                <Button size="sm" variant="secondary" disabled={convert.pending || !nl.trim()}>{convert.pending ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}To SQL</Button>
              </form>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {sim.sampleQueries.slice(1, 6).map((q) => (
                <button key={q} onClick={() => collab.setText(q + ";")} className="max-w-[220px] truncate rounded border px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted">{q}</button>
              ))}
            </div>
          </Panel>

          <Panel title="Execution">
            {!result ? (
              <p className="py-12 text-center text-sm text-muted-foreground">Run a query to see results, its plan and routing messages.</p>
            ) : (
              <Tabs value={tab} onValueChange={setTab}>
                <div className="flex flex-wrap items-center gap-2">
                  <TabsList>
                    <TabsTrigger value="results">Results</TabsTrigger>
                    <TabsTrigger value="plan">Plan</TabsTrigger>
                    <TabsTrigger value="messages">Messages</TabsTrigger>
                  </TabsList>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{result.node} · {fmtMs(result.ms)}</span>
                </div>
                <TabsContent value="results" className="mt-3 max-h-72 overflow-auto">
                  <table className="w-full font-mono text-xs">
                    <thead className="sticky top-0 bg-card text-left text-muted-foreground"><tr>{result.columns.map((c) => <th key={c} className="pb-1.5 pr-4 font-normal">{c}</th>)}</tr></thead>
                    <tbody>{result.rows.map((r, i) => <tr key={i} className="border-t">{result.columns.map((c) => <td key={c} className="py-1 pr-4 whitespace-nowrap">{String(r[c])}</td>)}</tr>)}</tbody>
                  </table>
                </TabsContent>
                <TabsContent value="plan" className="mt-3">{result.plan && <QueryVisualizer plan={result.plan} />}</TabsContent>
                <TabsContent value="messages" className="mt-3 space-y-1 font-mono text-xs text-muted-foreground">{result.messages.map((m) => <div key={m}>{m}</div>)}</TabsContent>
              </Tabs>
            )}
          </Panel>

          {compare && (
            <Panel title="Original vs optimized" className="lg:col-span-2 xl:col-span-1 2xl:col-span-2" action={<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCompare(null)}>Close</Button>}>
              <div className="grid gap-3 md:grid-cols-2">
                <div><div className="mb-1 text-xs text-muted-foreground">Original</div><pre className="whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">{collab.text}</pre></div>
                <div><div className="mb-1 text-xs text-success">Optimized (≈{compare.improvement}% faster)</div><pre className="whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">{compare.sql}</pre></div>
              </div>
            </Panel>
          )}
        </div>

        <div className="space-y-3">
          <Panel title={remote.data ? "AI insights · backend" : "AI insights"} action={remote.loading ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <Sparkles className="size-3.5 text-primary" />}>
            <div className="max-h-[520px] space-y-2 overflow-auto">
              {suggestions.length === 0 && <p className="text-sm text-muted-foreground">No issues found for this query.</p>}
              {suggestions.map((s) => (
                <div key={s.id} className="rounded-md border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${s.kind === "WARNING" ? "bg-warning/15 text-warning" : s.kind === "INDEX_SUGGESTION" ? "bg-success/15 text-success" : "bg-primary/15 text-primary"}`}>{s.kind.replace("_", " ")}</span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">{Math.round(s.confidence * 100)}% conf</span>
                  </div>
                  <div className="text-sm font-medium">{s.title}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="font-mono text-xs text-success">−{s.improvement}% est.</span>
                    <div className="ml-auto flex gap-1">
                      {s.kind === "REWRITE_PROPOSAL" && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCompare(s)}>Compare</Button>}
                      <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={applied.has(s.id)} onClick={() => {
                        setApplied((a) => new Set(a).add(s.id));
                        if (s.kind === "REWRITE_PROPOSAL" && s.sql) collab.setText(s.sql);
                        else navigator.clipboard?.writeText(s.sql ?? "");
                        toast.success(s.kind === "REWRITE_PROPOSAL" ? "Rewrite applied to editor" : "Statement copied to clipboard");
                      }}>{applied.has(s.id) ? <><Check className="size-3" />Applied</> : "Apply"}</Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          {history.length > 0 && (
            <Panel title="Query history">
              <div className="max-h-64 space-y-1.5 overflow-auto">
                {history.map((h) => (
                  <button key={h.id} onClick={() => collab.setText(h.sql)} className="block w-full rounded border px-2 py-1.5 text-left hover:bg-muted">
                    <div className="flex font-mono text-[11px] text-muted-foreground"><span>{fmtTime(new Date(h.executedAt).getTime())}</span><span className={`ml-auto ${h.status === "success" ? "text-success" : "text-destructive"}`}>{h.status} · {h.duration}</span></div>
                    <div className="truncate font-mono text-xs">{h.sql}</div>
                  </button>
                ))}
              </div>
            </Panel>
          )}
          <Panel title="Version history">
            {collab.versions.length === 0 ? <p className="text-xs text-muted-foreground">Snapshots are saved every 30s or on demand.</p> : (
              <div className="space-y-1.5">
                {collab.versions.map((v) => (
                  <button key={v.t} onClick={() => collab.setText(v.sql)} className="block w-full rounded border px-2 py-1.5 text-left hover:bg-muted">
                    <div className="flex font-mono text-[11px] text-muted-foreground"><span>{fmtTime(v.t)}</span><span className="ml-auto">{v.by}</span></div>
                    <div className="truncate font-mono text-xs">{v.sql}</div>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
