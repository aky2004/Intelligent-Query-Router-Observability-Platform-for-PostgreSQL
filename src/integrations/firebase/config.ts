// Firebase configuration
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

const apiKey = import.meta.env["VITE_FIREBASE_API_KEY"] || "";
const authDomain = import.meta.env["VITE_FIREBASE_AUTH_DOMAIN"] || "";
const projectId = import.meta.env["VITE_FIREBASE_PROJECT_ID"] || "pgpooler";

export const isFirebaseConfigured = Boolean(apiKey && apiKey.length > 5);

const firebaseConfig = {
  apiKey: isFirebaseConfigured ? apiKey : "AIzaSyDummyKeyForLocalDevOnly123456",
  authDomain: authDomain || `${projectId}.firebaseapp.com`,
  projectId: projectId,
  storageBucket: import.meta.env["VITE_FIREBASE_STORAGE_BUCKET"] || `${projectId}.appspot.com`,
  messagingSenderId: import.meta.env["VITE_FIREBASE_MESSAGING_SENDER_ID"] || "102725506520",
  appId: import.meta.env["VITE_FIREBASE_APP_ID"] || "1:102725506520:web:dummy",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

let authInstance: Auth | null = null;
try {
  authInstance = getAuth(firebaseApp);
} catch (e) {
  console.warn("Firebase Auth disabled or uninitialized:", (e as Error).message);
}

export const firebaseAuth = authInstance;
