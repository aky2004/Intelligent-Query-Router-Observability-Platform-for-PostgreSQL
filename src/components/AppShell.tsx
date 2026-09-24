import { Link, useHydrated, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { retryLive, startLive } from "@/lib/live";
import { useDataSource } from "@/hooks/use-backend";
import { Activity, AlertTriangle, Code2, Gauge, History, Settings, Database, LogOut } from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import { useSim } from "@/lib/sim";
import { StatusDot } from "@/components/common";
import { Button } from "@/components/ui/button";
import { signOut as endSession } from "@/lib/auth";

const items = [
  { title: "Dashboard", url: "/dashboard", icon: Gauge },
  { title: "Query Explorer", url: "/explorer", icon: Code2 },
  { title: "Metrics", url: "/metrics", icon: Activity },
  { title: "Anomalies", url: "/anomalies", icon: AlertTriangle },
  { title: "Replay", url: "/replay", icon: History },
  { title: "Settings", url: "/settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  if (!hydrated) return <div className="grid min-h-screen place-items-center font-mono text-sm text-muted-foreground">connecting to router…</div>;
  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (r) => r.location.pathname });
  const nodes = useSim((s) => s.nodes);
  const connected = useSim((s) => s.connected);
  const openAlerts = useSim((s) => s.alerts.filter((a) => !a.acknowledged && a.severity === "critical").length);
  const { source, lastUpdated, error } = useDataSource();
  useEffect(() => { void startLive(); }, []);
  const mins = lastUpdated ? Math.max(0, Math.round((Date.now() - lastUpdated) / 60000)) : 0;
  const label = !connected ? "paused" : source === "live" ? "live · backend" : source === "connecting" ? "connecting…" : source === "stale" ? "offline · cached" : "live · simulated";
  const signOut = async () => {
    try { await endSession(); } finally {
      await navigate({ to: "/auth", search: { mode: "login" }, replace: true });
    }
  };
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><Database className="size-4" /></div>
               <span className="font-display text-sm font-semibold group-data-[collapsible=icon]:hidden">pg-router-ai</span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Observability</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((it) => (
                    <SidebarMenuItem key={it.url}>
                      <SidebarMenuButton asChild isActive={path === it.url} tooltip={it.title}>
                        <Link to={it.url}>
                          <it.icon />
                          <span>{it.title}</span>
                          {it.url === "/anomalies" && openAlerts > 0 && (
                            <span className="ml-auto rounded bg-destructive px-1.5 font-mono text-[10px] text-destructive-foreground">{openAlerts}</span>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupLabel>Nodes</SidebarGroupLabel>
              <SidebarGroupContent className="space-y-1.5 px-2 font-mono text-xs">
                {nodes.map((n) => (
                  <div key={n.id} className="flex items-center gap-2">
                    <StatusDot status={n.status} />
                    <span className="flex-1">{n.id}</span>
                    <span className="text-muted-foreground">{n.role === "replica" ? `${Math.round(n.lagMs)}ms` : "rw"}</span>
                  </div>
                ))}
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b bg-background/85 px-3 backdrop-blur">
            <SidebarTrigger />
            <span className="font-mono text-xs text-muted-foreground">{items.find((i) => i.url === path)?.title ?? ""}</span>
            <div className="ml-auto flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <span className={`size-2 rounded-full ${!connected ? "bg-muted-foreground" : source === "live" ? "bg-success animate-pulse" : source === "stale" ? "bg-warning" : "bg-primary animate-pulse"}`} />
              <span title={error ?? undefined}>{label}</span>
              {(source === "stale" || (source === "simulated" && error)) && (
                <Button variant="ghost" size="icon" onClick={() => void retryLive()} aria-label="Retry backend connection" title="Retry backend connection"><RefreshCw /></Button>
              )}
              <Button variant="ghost" size="icon" onClick={() => void signOut()} aria-label="Sign out" title="Sign out"><LogOut /></Button>
            </div>
          </header>
          <main className="mosaic flex-1 p-4 md:p-6">
            {source === "stale" && (
              <div role="status" className="mb-3 flex flex-wrap items-center gap-2 border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-xs">
                <span>{error} Showing cached data · last updated {mins === 0 ? "just now" : `${mins} min ago`}.</span>
                <Button size="sm" variant="secondary" className="ml-auto h-7" onClick={() => void retryLive()}>Retry</Button>
              </div>
            )}
            {source === "connecting" ? (
              <div className="space-y-3" aria-label="Loading data">
                <Skeleton className="h-8 w-64" />
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>
                <Skeleton className="h-64" />
              </div>
            ) : children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
