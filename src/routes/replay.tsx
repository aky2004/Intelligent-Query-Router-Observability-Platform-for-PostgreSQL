import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Upload, Play, Square, Pause, Download, Copy, Check, RefreshCw, FileText, ChevronDown, ChevronUp, Database } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel, Stat } from "@/components/common";
import { useSim } from "@/lib/sim";
import { api, errorMessage, getApiUrl, uploadFile } from "@/lib/api";
import { socketService } from "@/lib/socket";
import { fmtMs, truncate } from "@/lib/format";

interface StatusRes {
  status: "running" | "paused" | "completed" | "failed";
  progress: { current: number; total: number; percentage: number };
  stats: { queriesExecuted: number; avgLatency: number; errors: number; mismatches: number };
  currentQuery?: { sql: string };
}
interface Mismatch {
  query: string;
  originalResult: unknown;
  replayResult: unknown;
  difference: string;
}

export const Route = createFileRoute("/replay")({
  head: () => ({
    meta: [
      { title: "Query Replay — pg-router-ai" },
      { name: "description", content: "Replay captured production traffic against a target database and compare results." },
      { property: "og:title", content: "Query Replay — pg-router-ai" },
      { property: "og:description", content: "Replay captured production traffic against a target database and compare results." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Replay,
});

interface Captured {
  sql: string;
  durationMs: number;
  offsetMs: number;
  timestamp?: string | undefined;
}
interface Outcome extends Captured {
  replayMs: number;
  match: boolean;
}

function Replay() {
  const [capture, setCapture] = useState<Captured[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [speed, setSpeed] = useState("1");
  const [target, setTarget] = useState("replica-1");
  const [done, setDone] = useState<Outcome[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const paused = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const live = useSim((st) => st.source === "live");
  const [liveLimit, setLiveLimit] = useState<string>("50");
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [rawJsonl, setRawJsonl] = useState<string>("");
  const [loadingLive, setLoadingLive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [remote, setRemote] = useState<{ id: string; status: StatusRes | null; mismatches: Mismatch[] } | null>(null);

  const loadLiveCapture = async (customLimit?: string) => {
    setLoadingLive(true);
    const lim = customLimit ?? liveLimit;
    try {
      const res = await api<{
        uploadId: string;
        fileName: string;
        totalAvailable?: number;
        count: number;
        queries: Array<{ sql: string; durationMs: number; offsetMs: number; timestamp?: string }>;
        rawJsonl: string;
      }>(`/api/replay/live-capture?limit=${lim}`);

      if (!res.count || res.queries.length === 0) {
        toast.info("No queries captured yet. Execute queries in Query Explorer or send app traffic!");
      } else {
        setCapture(res.queries);
        setFileName(res.fileName);
        setUploadId(res.uploadId);
        setRawJsonl(res.rawJsonl);
        setFile(null);
        setRemote(null);
        setDone([]);
        toast.success(`Loaded latest ${res.count} queries${res.totalAvailable ? ` (out of ${res.totalAvailable} captured)` : ""}!`);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingLive(false);
    }
  };

  const downloadLiveLog = () => {
    const base = getApiUrl() || "http://localhost:3000";
    window.open(`${base}/api/replay/download`, "_blank");
    toast.success("Downloading captured .jsonl file...");
  };

  const copyJsonl = async () => {
    try {
      let content = rawJsonl;
      if (!content && capture && capture.length > 0) {
        content = capture.map((q) => JSON.stringify({
          timestamp: q.timestamp || new Date().toISOString(),
          sql: q.sql,
          durationMs: q.durationMs,
          offsetMs: q.offsetMs,
        })).join("\n");
      }
      if (!content) {
        toast.error("No capture content loaded to copy");
        return;
      }
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Copied captured JSONL to clipboard!");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const startRemote = async () => {
    if (!uploadId && !file) return;
    setRunning(true);
    setUploadPct(0);
    try {
      let currentUploadId = uploadId;
      if (!currentUploadId && file) {
        const up = await uploadFile<{ uploadId: string; queryCount: number }>("/api/replay/upload", file, setUploadPct);
        currentUploadId = up.uploadId;
        setUploadId(currentUploadId);
      }
      if (!currentUploadId) throw new Error("No upload session ready");

      const { replayId } = await api<{ replayId: string }>("/api/replay/start", {
        method: "POST",
        json: { uploadId: currentUploadId, targetNode: target, speed: Number(speed), compareResults: true },
      });
      setRemote({ id: replayId, status: null, mismatches: [] });

      const finish = async () => {
        clearInterval(poll);
        offP();
        offC();
        const c = await api<{ mismatches: Mismatch[] }>(`/api/replay/${replayId}/comparison`).catch(() => ({ mismatches: [] }));
        setRemote((r) => r && { ...r, mismatches: c.mismatches });
        setRunning(false);
      };

      const refresh = async () => {
        try {
          const st = await api<StatusRes>(`/api/replay/${replayId}/status`, { retries: 1 });
          setRemote((r) => r && { ...r, status: st });
          if (st.status === "completed" || st.status === "failed") void finish();
        } catch { /* keep polling */ }
      };

      const poll = setInterval(refresh, 2000);
      const offP = socketService.subscribe("replay:progress", (m: { replayId: string; current: number; total: number; currentQuery?: { sql: string } }) => {
        if (m.replayId === replayId) {
          setRemote((r) => r && {
            ...r,
            status: {
              ...(r.status ?? { status: "running", stats: { queriesExecuted: 0, avgLatency: 0, errors: 0, mismatches: 0 } }),
              progress: { current: m.current, total: m.total, percentage: (m.current / m.total) * 100 },
              currentQuery: m.currentQuery,
            } as StatusRes,
          });
        }
      });
      const offC = socketService.subscribe("replay:complete", (m: { replayId: string }) => {
        if (m.replayId === replayId) void finish();
      });
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setRunning(false);
    }
  };

  const togglePause = async () => {
    const next = !isPaused;
    setIsPaused(next);
    paused.current = next;
    if (remote) await api(`/api/replay/${remote.id}/${next ? "pause" : "resume"}`, { method: "POST" }).catch((e) => toast.error(errorMessage(e)));
  };

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(typeof v === "string" ? v : JSON.stringify(v)).replace(/"/g, '""')}"`;
    const lines = remote?.mismatches.length
      ? [["query", "original", "replay", "difference"], ...remote.mismatches.map((m) => [m.query, m.originalResult, m.replayResult, m.difference])]
      : [["query", "original_ms", "replay_ms", "match"], ...done.map((d) => [d.sql, d.durationMs.toFixed(2), d.replayMs.toFixed(2), d.match])];
    const blob = new Blob([lines.map((l) => l.map(esc).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "replay-results.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onFile = async (f: File) => {
    setFile(f);
    setUploadId(null);
    setRemote(null);
    const text = await f.text();
    setRawJsonl(text);
    try {
      const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const t0 = new Date(rows[0].timestamp ?? 0).getTime();
      setCapture(rows.map((r) => ({
        sql: r.sql ?? r.query,
        durationMs: Number(r.durationMs ?? r.duration ?? 5),
        offsetMs: new Date(r.timestamp ?? 0).getTime() - t0,
        timestamp: r.timestamp,
      })));
      setFileName(f.name);
      setDone([]);
      toast.success(`Loaded ${rows.length} queries from ${f.name}`);
    } catch {
      toast.error("Could not read file — expected JSON lines with sql, durationMs and timestamp");
    }
  };

  const start = async () => {
    if (!capture) return;
    setRunning(true);
    setDone([]);
    stop.current = false;
    const k = Number(speed);
    const t0 = performance.now();
    for (const q of capture) {
      while (paused.current && !stop.current) await new Promise((r) => setTimeout(r, 200));
      if (stop.current) break;
      const wait = q.offsetMs / k - (performance.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 800)));
      const replayMs = q.durationMs * (0.6 + Math.random() * 0.9);
      setDone((d) => [...d, { ...q, replayMs, match: Math.random() > 0.04 }]);
    }
    setRunning(false);
  };

  const rs = remote?.status;
  const total = rs ? rs.progress.total : capture?.length ?? 0;
  const doneCount = rs ? rs.progress.current : done.length;
  const mismatches = rs ? rs.stats.mismatches : done.filter((d) => !d.match).length;
  const avgDelta = done.length ? done.reduce((a, d) => a + (d.replayMs - d.durationMs), 0) / done.length : 0;

  const nodes = useSim((s) => s.nodes);
  const targetNodes = nodes.length > 0 ? nodes.map((n) => n.id) : ["primary", "replica-1", "replica-2"];

  const loadSampleTraffic = () => {
    const sample: Captured[] = [
      { sql: "SELECT id, email, created_at FROM accounts ORDER BY id DESC LIMIT 10", durationMs: 4.2, offsetMs: 0, timestamp: new Date().toISOString() },
      { sql: "SELECT count(*) FROM orders WHERE created_at > NOW() - INTERVAL '1 day'", durationMs: 14.5, offsetMs: 150, timestamp: new Date().toISOString() },
      { sql: "SELECT * FROM users WHERE status = 'active' LIMIT 25", durationMs: 6.1, offsetMs: 300, timestamp: new Date().toISOString() },
      { sql: "SELECT id, name, price, stock FROM products WHERE stock > 0 ORDER BY price ASC LIMIT 10", durationMs: 5.3, offsetMs: 500, timestamp: new Date().toISOString() },
      { sql: "SELECT AVG(total_amount) FROM transactions WHERE status = 'completed'", durationMs: 11.2, offsetMs: 750, timestamp: new Date().toISOString() },
    ];
    setCapture(sample);
    setFileName("sample-captured-traffic.jsonl");
    setRawJsonl(sample.map((s) => JSON.stringify(s)).join("\n"));
    setUploadId(null);
    setFile(null);
    setDone([]);
    toast.success("Loaded 5 sample production queries for replay!");
  };

  return (
    <>
      <PageHeader title="Query replay" sub="Re-run captured traffic and diff results against the original run" />
      <div className="grid gap-3 lg:grid-cols-[380px_1fr] lg:items-stretch">
        <Panel title="Configure" className="flex flex-col h-full" bodyClassName="flex flex-col flex-1">
          {/* Live Automatic Capture Card */}
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3.5 mb-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  Live Router Capture
                </span>
              </div>
              <Badge variant="outline" className="text-[10px] bg-background/50 font-mono">
                Auto-Logging
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              pg-router-ai continuously logs executed queries to <code className="bg-muted px-1 py-0.5 rounded text-[10px]">backend/captures/</code>.
            </p>
            
            <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5">
              <span>Fetch latest:</span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={liveLimit}
                onValueChange={(v) => v && setLiveLimit(v)}
                className="scale-90 origin-right gap-0.5"
              >
                {["10", "25", "50", "100", "500"].map((n) => (
                  <ToggleGroupItem key={n} value={n} className="font-mono text-[10px] h-5 px-1.5">
                    {n}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <div className="flex flex-col gap-1.5 pt-1">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="w-full text-xs font-mono justify-center gap-1.5"
                disabled={loadingLive}
                onClick={() => void loadLiveCapture()}
              >
                <RefreshCw className={`size-3.5 ${loadingLive ? "animate-spin" : ""}`} />
                {loadingLive ? "Loading Traffic..." : `Load Latest ${liveLimit} Queries`}
              </Button>
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs font-mono justify-center gap-1"
                  onClick={downloadLiveLog}
                >
                  <Download className="size-3" />
                  Download .jsonl
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs font-mono justify-center gap-1"
                  onClick={copyJsonl}
                >
                  {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                  {copied ? "Copied!" : "Copy JSONL"}
                </Button>
              </div>
            </div>
          </div>

          <div className="relative my-3 text-center">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-dashed" /></div>
            <span className="relative bg-card px-2 text-[10px] uppercase text-muted-foreground">Or upload custom log</span>
          </div>

          {/* Upload Custom File */}
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-4 text-center hover:bg-muted/40 transition-colors">
            <Upload className="size-4 text-muted-foreground" />
            <span className="text-xs font-medium truncate max-w-full px-2">{fileName || "Upload capture file (.jsonl)"}</span>
            <span className="text-[10px] text-muted-foreground">Upload any newline-delimited JSON log</span>
            <input type="file" accept=".jsonl,.json,.log,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1.5 w-full text-xs font-mono text-muted-foreground hover:text-foreground"
            onClick={loadSampleTraffic}
          >
            ⚡ Load Sample Traffic (5 queries)
          </Button>

          {/* Query Preview Section */}
          {capture && capture.length > 0 && (
            <div className="mt-3 rounded-md border bg-muted/20 p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-medium flex items-center gap-1.5">
                  <FileText className="size-3.5 text-primary" />
                  {capture.length} queries loaded
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {showPreview ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  {showPreview ? "Hide" : "Preview"}
                </Button>
              </div>
              {showPreview && (
                <div className="mt-2 max-h-48 overflow-y-auto space-y-1.5 pr-1 font-mono text-[11px]">
                  {capture.map((q, idx) => (
                    <div key={idx} className="rounded bg-background/80 p-1.5 border text-xs leading-tight">
                      <div className="text-muted-foreground text-[10px] flex justify-between">
                        <span>#{idx + 1}</span>
                        <span>{fmtMs(q.durationMs)}</span>
                      </div>
                      <div className="truncate mt-0.5 text-foreground font-mono">{q.sql}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Replay Controls */}
          <div className="mt-auto pt-4 space-y-4">
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">Replay Speed</div>
              <ToggleGroup type="single" variant="outline" size="sm" value={speed} onValueChange={(v) => v && setSpeed(v)}>
                {["0.5", "1", "2", "10"].map((s) => <ToggleGroupItem key={s} value={s} className="font-mono text-xs">{s}×</ToggleGroupItem>)}
              </ToggleGroup>
            </div>
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">Target database</div>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {targetNodes.map((n) => (
                    <SelectItem key={n} value={n}>
                      <span className="flex items-center gap-1.5">
                        <Database className="size-3 text-muted-foreground" />
                        {n}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {running ? (
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => void togglePause()}>
                  {isPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  {isPaused ? "Resume" : "Pause"}
                </Button>
                {!remote && (
                  <Button variant="destructive" className="flex-1" onClick={() => (stop.current = true)}>
                    <Square className="size-3.5" />
                    Stop
                  </Button>
                )}
              </div>
            ) : (
              <Button
                className="w-full"
                disabled={!capture || capture.length === 0}
                onClick={() => void (live && (uploadId || file) ? startRemote() : start())}
              >
                <Play className="size-3.5" />
                Start replay ({total} queries){live && (uploadId || file) ? " on backend" : ""}
              </Button>
            )}
          </div>
        </Panel>

        <div className="flex flex-col gap-3 h-full">
          <Panel title="Progress">
            {running && live && file && uploadPct < 100 && (
              <div className="mb-2">
                <div className="mb-1 font-mono text-xs text-muted-foreground">Uploading {Math.round(uploadPct)}%</div>
                <Progress value={uploadPct} className="h-1" />
              </div>
            )}
            <Progress value={total ? (doneCount / total) * 100 : 0} className="h-2" />
            {rs?.currentQuery && <div className="mt-2 truncate font-mono text-xs">{rs.currentQuery.sql}</div>}
            <div className="mt-2 flex justify-between font-mono text-xs text-muted-foreground">
              <span>{doneCount}/{total} on {target}</span>
              <span>{speed}× speed</span>
            </div>
          </Panel>

          <div className="grid grid-cols-3 gap-3">
            <Stat label="Replayed" value={String(doneCount)} />
            <Stat label="Mismatches" value={String(mismatches)} tone={mismatches ? "destructive" : "success"} />
            <Stat label="Avg Δ time" value={`${avgDelta >= 0 ? "+" : ""}${fmtMs(Math.abs(avgDelta))}`} tone={avgDelta > 5 ? "warning" : "success"} />
          </div>

          <Panel
            title="Result comparison"
            className="flex-1 flex flex-col min-h-[320px]"
            bodyClassName="flex-1 flex flex-col min-h-0"
            action={(done.length > 0 || (remote?.mismatches.length ?? 0) > 0) ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={exportCsv}>
                <Download className="size-3" />
                CSV
              </Button>
            ) : undefined}
          >
            {remote && remote.mismatches.length > 0 && (
              <div className="mb-3 space-y-2">
                {remote.mismatches.map((m, i) => (
                  <div key={i} className="border p-2 font-mono text-xs">
                    <div className="truncate">{m.query}</div>
                    <div className="text-destructive">{m.difference}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full font-mono text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-normal">Query</th>
                    <th className="pb-2 text-right font-normal">Original</th>
                    <th className="pb-2 text-right font-normal">Replay</th>
                    <th className="pb-2 text-right font-normal">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {[...done].reverse().slice(0, 200).map((d, i) => (
                    <tr key={i} className="border-t">
                      <td className="max-w-0 truncate py-1.5 pr-3">{truncate(d.sql, 70)}</td>
                      <td className="py-1.5 text-right">{fmtMs(d.durationMs)}</td>
                      <td className={`py-1.5 text-right ${d.replayMs > d.durationMs * 1.3 ? "text-warning" : ""}`}>{fmtMs(d.replayMs)}</td>
                      <td className={`py-1.5 pl-3 text-right ${d.match ? "text-success" : "text-destructive"}`}>{d.match ? "match" : "diff"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {done.length === 0 && !remote && (
                <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-muted-foreground">
                  Load live traffic or a capture file and start the replay.
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

