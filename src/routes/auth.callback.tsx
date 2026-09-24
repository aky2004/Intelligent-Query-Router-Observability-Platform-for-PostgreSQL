import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { refreshSession } from "@/lib/auth";

export const Route=createFileRoute("/auth/callback")({
  head:()=>({meta:[{title:"Verifying account — pg-router-ai"},{name:"description",content:"Completing secure account verification."},{property:"og:title",content:"Verifying account — pg-router-ai"},{property:"og:description",content:"Completing secure account verification."},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary"}]}),
  component:AuthCallback,
});

function AuthCallback(){
  const navigate=useNavigate();
  const[error,setError]=useState("");
  useEffect(()=>{let active=true;void refreshSession().then(user=>{if(!active)return;if(user)void navigate({to:"/dashboard",replace:true});else setError("This verification link is invalid or expired.");});return()=>{active=false};},[navigate]);
  return <main className="mosaic grid min-h-screen place-items-center p-5"><div className="relative w-full max-w-lg border bg-background p-8"><span className="tech-label text-primary">ACCOUNT VERIFICATION</span><h1 className="mt-4 font-display text-4xl font-bold">{error?"Unable to verify":"Verifying account…"}</h1>{error&&<><p className="mt-3 text-sm text-destructive">{error}</p><Button className="mt-6" onClick={()=>void navigate({to:"/auth",search:{mode:"login"},replace:true})}>Return to sign in</Button></>}</div></main>;
}