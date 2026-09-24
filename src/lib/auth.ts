import {
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  type User,
} from "firebase/auth";
import { firebaseAuth, isFirebaseConfigured } from "@/integrations/firebase/config";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  preferences: Record<string, unknown>;
  role: "admin" | "operator" | "viewer";
}

let accessToken: string | null = null;
const listeners = new Set<() => void>();

export const authStore = {
  get token() {
    return accessToken;
  },
  set(token: string | null) {
    accessToken = token;
    for (const l of listeners) l();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// Keep the token up-to-date whenever Firebase's auth state changes
if (firebaseAuth && isFirebaseConfigured) {
  try {
    onAuthStateChanged(firebaseAuth, async (user) => {
      if (user) {
        const token = await user.getIdToken();
        authStore.set(token);
      } else {
        authStore.set(null);
      }
    });
  } catch (e) {
    console.warn("Failed to attach auth state change listener:", e);
  }
}

function firebaseUserToSession(user: User): SessionUser {
  return {
    id: user.uid,
    email: user.email ?? "",
    displayName:
      user.displayName ?? user.email?.split("@")[0] ?? "User",
    avatarUrl: user.photoURL,
    preferences: {},
    role: "viewer",
  };
}

export async function signInWithGoogle(): Promise<SessionUser | null> {
  if (!firebaseAuth || !isFirebaseConfigured) {
    throw new Error(
      "Firebase credentials missing. Please set VITE_FIREBASE_API_KEY and VITE_FIREBASE_APP_ID in your .env file."
    );
  }
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(firebaseAuth, provider);
  const token = await result.user.getIdToken();
  authStore.set(token);
  return firebaseUserToSession(result.user);
}

export async function signOut(): Promise<void> {
  if (firebaseAuth && isFirebaseConfigured) {
    await firebaseSignOut(firebaseAuth);
  }
  authStore.set(null);
}

export async function refreshSession(): Promise<SessionUser | null> {
  try {
    if (!firebaseAuth || !isFirebaseConfigured) {
      authStore.set(null);
      return null;
    }
    const user = firebaseAuth.currentUser;
    if (!user) {
      return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(firebaseAuth, async (u) => {
          unsubscribe();
          if (u) {
            const token = await u.getIdToken();
            authStore.set(token);
            resolve(firebaseUserToSession(u));
          } else {
            authStore.set(null);
            resolve(null);
          }
        });
      });
    }
    const token = await user.getIdToken(/* forceRefresh */ true);
    authStore.set(token);
    return firebaseUserToSession(user);
  } catch {
    authStore.set(null);
    return null;
  }
}
