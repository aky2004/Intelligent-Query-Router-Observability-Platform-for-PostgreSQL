import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "@/components/LandingPage";
export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "pg-router-ai — Precision PostgreSQL routing" },
    { name: "description", content: "Route, inspect and replay PostgreSQL traffic from one precise control plane." },
    { property: "og:title", content: "pg-router-ai — Precision PostgreSQL routing" },
    { property: "og:description", content: "Route, inspect and replay PostgreSQL traffic from one precise control plane." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" },
  ]}), component: LandingPage,
});
