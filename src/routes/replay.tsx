import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Upload, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader, Panel, Stat } from "@/components/common";
import { sim, useSim } from "@/lib/sim";
import { api, errorMessage, uploadFile } from "@/lib/api";
import { socketService } from "@/lib/socket";
import { Pause, Download } from "lucide-react";

interface StatusRes { status: "running" | "paused" | "completed" | "failed"; progress: { current: number; total: number; percentage: number }; stats: { queriesExecuted: number; avgLatency: number; errors: number; mismatches: number }; currentQuery?: { sql: string } }
interface Mismatch { query: string; originalResult: unknown; replayResult: unknown; difference: string }
import { fmtMs, truncate } from "@/lib/format";

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

interface Captured { sql: string; durationMs: number; offsetMs: number }
interface Outcome extends Captured { replayMs: number; match: boolean }

function demoCapture(): Captured[] {
  let off = 0;
  return Array.from({ length: 120 }, () => {
    off += Math.random() * 400;
    return { sql: sim.sampleQueries[Math.floor(Math.random() * sim.sampleQueries.length)]!, durationMs: 2 + Math.random() * 60, offsetMs: off };
  });
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
  const [file, setFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [remote, setRemote] = useState<{ id: string; status: StatusRes | null; mismatches: Mismatch[] } | null>(null);

  const startRemote = async () => {
    if (!file) return;
    setRunning(true); setUploadPct(0);
    try {
      const up = await uploadFile<{ uploadId: string; queryCount: number }>("/api/replay/upload", file, setUploadPct);
      const { replayId } = await api<{ replayId: string }>("/api/replay/start", { method: "POST", json: { uploadId: up.uploadId, targetNode: target, speed: Number(speed), compareResults: true } });
      setRemote({ id: replayId, status: null, mismatches: [] });
      const finish = async () => {
        clearInterval(poll); offP(); offC();
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
      const offP = socketService.subscribe("replay:progress", (m: { replayId: string; current: number; total: number; currentQuery?: { sql: string } }) => m.replayId === replayId && setRemote((r) => r && { ...r, status: { ...(r.status ?? { status: "running", stats: { queriesExecuted: 0, avgLatency: 0, errors: 0, mismatches: 0 } }), progress: { current: m.current, total: m.total, percentage: (m.current / m.total) * 100 }, currentQuery: m.currentQuery } as StatusRes }));
      const offC = socketService.subscribe("replay:complete", (m: { replayId: string }) => m.replayId === replayId && void finish());
      void refresh();
    } catch (e) {
      toast.error(errorMessage(e)); setRunning(false);
    }
  };
  const togglePause = async () => {
    const next = !isPaused;
    setIsPaused(next); paused.current = next;
    if (remote) await api(`/api/replay/${remote.id}/${next ? "pause" : "resume"}`, { method: "POST" }).catch((e) => toast.error(errorMessage(e)));
  };
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(typeof v === "string" ? v : JSON.stringify(v)).replace(/"/g, '""')}"`;
    const lines = remote?.mismatches.length
      ? [["query", "original", "replay", "difference"], ...remote.mismatches.map((m) => [m.query, m.originalResult, m.replayResult, m.difference])]
      : [["query", "original_ms", "replay_ms", "match"], ...done.map((d) => [d.sql, d.durationMs.toFixed(2), d.replayMs.toFixed(2), d.match])];
    const blob = new Blob([lines.map((l) => l.map(esc).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "replay-results.csv"; a.click(); URL.revokeObjectURL(a.href);
  };

  const onFile = async (f: File) => {
    setFile(f); setRemote(null);
    const text = await f.text();
    try {
      const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const t0 = new Date(rows[0].timestamp ?? 0).getTime();
      setCapture(rows.map((r) => ({ sql: r.sql ?? r.query, durationMs: Number(r.durationMs ?? r.duration ?? 5), offsetMs: new Date(r.timestamp ?? 0).getTime() - t0 })));
      setFileName(f.name);
      setDone([]);
    } catch {
      toast.error("Could not read file — expected JSON lines with sql, durationMs and timestamp");
    }
  };

  const start = async () => {
    if (!capture) return;
    setRunning(true); setDone([]); stop.current = false;
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

  return (
    <>
      <PageHeader title="Query replay" sub="Re-run captured traffic and diff results against the original run" />
      <div className="grid gap-3 lg:grid-cols-[340px_1fr]">
        <Panel title="Configure">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center hover:bg-muted/40">
            <Upload className="size-5 text-muted-foreground" />
            <span className="text-sm">{fileName || "Upload capture file (.jsonl)"}</span>
            <input type="file" accept=".jsonl,.json,.log,.txt" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          </label>
          <Button variant="link" size="sm" className="mt-1 px-0" onClick={() => { setCapture(demoCapture()); setFileName("demo-capture.jsonl"); setDone([]); }}>or load a demo capture</Button>
          <div className="mt-4 space-y-4">
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">Speed</div>
              <ToggleGroup type="single" variant="outline" size="sm" value={speed} onValueChange={(v) => v && setSpeed(v)}>
                {["0.5", "1", "2", "10"].map((s) => <ToggleGroupItem key={s} value={s} className="font-mono text-xs">{s}×</ToggleGroupItem>)}
              </ToggleGroup>
            </div>
            <div>
              <div className="mb-1.5 text-xs text-muted-foreground">Target database</div>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["primary", "replica-1", "replica-2"].map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {running ? (
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => void togglePause()}>{isPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}{isPaused ? "Resume" : "Pause"}</Button>
                {!remote && <Button variant="destructive" className="flex-1" onClick={() => (stop.current = true)}><Square className="size-3.5" />Stop</Button>}
              </div>
            ) : (
              <Button className="w-full" disabled={!capture} onClick={() => void (live && file ? startRemote() : start())}><Play className="size-3.5" />Start replay ({total} queries){live && file ? " on backend" : ""}</Button>
            )}
          </div>
        </Panel>

        <div className="space-y-3">
          <Panel title="Progress">
            {running && live && file && uploadPct < 100 && <div className="mb-2"><div className="mb-1 font-mono text-xs text-muted-foreground">Uploading {Math.round(uploadPct)}%</div><Progress value={uploadPct} className="h-1" /></div>}
            <Progress value={total ? (doneCount / total) * 100 : 0} className="h-2" />
            {rs?.currentQuery && <div className="mt-2 truncate font-mono text-xs">{rs.currentQuery.sql}</div>}
            <div className="mt-2 flex justify-between font-mono text-xs text-muted-foreground"><span>{doneCount}/{total} on {target}</span><span>{speed}× speed</span></div>
          </Panel>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Replayed" value={String(doneCount)} />
            <Stat label="Mismatches" value={String(mismatches)} tone={mismatches ? "destructive" : "success"} />
            <Stat label="Avg Δ time" value={`${avgDelta >= 0 ? "+" : ""}${fmtMs(Math.abs(avgDelta))}`} tone={avgDelta > 5 ? "warning" : "success"} />
          </div>
          <Panel title="Result comparison" action={(done.length > 0 || (remote?.mismatches.length ?? 0) > 0) ? <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={exportCsv}><Download className="size-3" />CSV</Button> : undefined}>
            {remote && remote.mismatches.length > 0 && (
              <div className="mb-3 space-y-2">{remote.mismatches.map((m, i) => <div key={i} className="border p-2 font-mono text-xs"><div className="truncate">{m.query}</div><div className="text-destructive">{m.difference}</div></div>)}</div>
            )}
            <div className="max-h-96 overflow-auto">
              <table className="w-full font-mono text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground"><tr><th className="pb-2 font-normal">Query</th><th className="pb-2 text-right font-normal">Original</th><th className="pb-2 text-right font-normal">Replay</th><th className="pb-2 text-right font-normal">Result</th></tr></thead>
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
              {done.length === 0 && !remote && <p className="py-8 text-center text-sm text-muted-foreground">Load a capture and start the replay.</p>}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
