import { Link } from "@tanstack/react-router";
import { Activity, ArrowRight, Database, Menu, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const links = [
  ["01", "Product", "/product"],
  ["02", "Security", "/security"],
  ["03", "Pricing", "/pricing"],
] as const;

export function PublicHeader() {
  const [open, setOpen] = useState(false);
  return <header className="fixed inset-x-0 top-0 z-50 border-b bg-background/95 backdrop-blur-sm">
    <div className="mx-auto flex h-16 max-w-[1440px] items-center px-4 md:px-8">
      <Link to="/" className="flex items-center gap-3" aria-label="pg-router-ai home">
        <span className="grid size-8 place-items-center bg-primary text-primary-foreground"><Database className="size-4" /></span>
        <span className="font-display text-base font-bold">pg-router-ai</span>
      </Link>
      <nav className="mx-auto hidden items-center gap-8 md:flex">
        {links.map(([n,label,to]) => <Link key={to} to={to} className="tech-label text-foreground/70 hover:text-primary"><span className="mr-1 text-primary/50">{n}.</span>{label}</Link>)}
      </nav>
      <div className="ml-auto hidden items-center gap-2 md:flex">
        <Button asChild variant="outline"><Link to="/auth" search={{ mode: "login" }}>Sign in</Link></Button>
        <Button asChild><Link to="/auth" search={{ mode: "signup" }}>Start routing <ArrowRight /></Link></Button>
      </div>
      <Button className="ml-auto md:hidden" variant="ghost" size="icon" onClick={() => setOpen(v => !v)} aria-label="Toggle navigation">{open ? <X/> : <Menu/>}</Button>
    </div>
    {open && <nav className="border-t bg-background p-4 md:hidden">{links.map(([n,label,to]) => <Link key={to} to={to} onClick={() => setOpen(false)} className="tech-label block border-b py-4">{n}. {label}</Link>)}<Button asChild className="mt-4 w-full"><Link to="/auth" search={{ mode: "login" }}>Open console</Link></Button></nav>}
  </header>;
}

export function StatusBadge({ children = "All systems nominal" }: { children?: string }) {
  return <span className="inline-flex items-center gap-2 border border-primary/20 px-3 py-1 tech-label"><span className="size-2 bg-primary" />{children}</span>;
}

export function NetworkTopology() {
  return <div className="topology relative mx-auto aspect-square w-full max-w-[450px] overflow-hidden border" aria-label="Animated database routing topology">
    <svg viewBox="0 0 450 450" className="absolute inset-0 size-full" role="img">
      <circle cx="225" cy="225" r="140" fill="none" stroke="currentColor" strokeOpacity=".35" strokeDasharray="5 7" />
      <circle cx="225" cy="225" r="82" fill="none" stroke="currentColor" strokeOpacity=".15" />
      <path d="M225 225L225 85M225 225L346 295M225 225L104 295" stroke="currentColor" strokeOpacity=".2" />
      <g className="orbit-origin"><rect x="217" y="77" width="16" height="16" className="fill-accent-coral"/><rect x="338" y="287" width="16" height="16" className="fill-accent-mint"/><rect x="96" y="287" width="16" height="16" className="fill-accent-gold"/></g>
      <rect x="217" y="217" width="16" height="16" className="fill-primary"/>
    </svg>
    <div className="absolute left-5 top-5 tech-label">ROUTING MAP / LIVE</div>
    <div className="absolute bottom-5 left-5 flex items-center gap-2 font-mono text-xs"><Activity className="size-3 text-primary"/> 24.8K QPS</div>
  </div>;
}

export function SiteFooter() {
  return <footer className="border-t bg-primary text-primary-foreground"><div className="mx-auto grid max-w-[1440px] gap-8 px-4 py-10 md:grid-cols-2 md:px-8"><div><div className="font-display text-2xl font-bold">pg-router-ai</div><p className="mt-2 max-w-md text-sm text-primary-foreground/70">Precision routing and observability for PostgreSQL teams that operate at scale.</p></div><div className="flex items-end gap-6 md:justify-end"><Link to="/security" className="tech-label">Security</Link><Link to="/pricing" className="tech-label">Pricing</Link><span className="tech-label">© 2026</span></div></div></footer>;
}

export function TrustMark() { return <span className="inline-flex items-center gap-2 tech-label"><ShieldCheck className="size-4"/> ACCESS CONTROLLED</span>; }
