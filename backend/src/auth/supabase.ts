/**
 * Verifies Firebase ID tokens sent by the dashboard.
 * Uses firebase-admin to validate tokens issued by Firebase Auth.
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";
import path from "path";

// Initialise once — load service-account.json if present, or use env vars
if (!getApps().length) {
  const saPath = path.resolve(process.cwd(), "service-account.json");
  if (fs.existsSync(saPath)) {
    try {
      const sa = JSON.parse(fs.readFileSync(saPath, "utf-8"));
      initializeApp({ credential: cert(sa) });
    } catch {
      initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || "pgpooler" });
    }
  } else {
    const projectId = process.env.FIREBASE_PROJECT_ID || "pgpooler";
    initializeApp({ projectId });
  }
}

const cache = new Map<string, { userId: string; email: string | null; exp: number }>();

export const firebaseAuthEnabled = (): boolean => true;

export const verifyFirebaseToken = async (
  token: string,
): Promise<{ userId: string; email: string | null } | null> => {
  // Check cache first
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit;

  try {
    const decoded = await getAuth().verifyIdToken(token);
    const entry = {
      userId: decoded.uid,
      email: decoded.email ?? null,
      exp: Date.now() + 60_000, // cache for 1 minute
    };
    cache.set(token, entry);
    if (cache.size > 5000) cache.clear();
    return entry;
  } catch {
    return null;
  }
};

/** Local testing only: AUTH_DISABLED=true skips auth. Never honoured in production. */
export const devAuthBypass = (): boolean =>
  process.env.AUTH_DISABLED === "true" && process.env.NODE_ENV !== "production";
