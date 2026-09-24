import { getCache } from "../config/redis";
import type { OtpPurpose, OtpRecord } from "./types";

const ttlSeconds = 10 * 60;
const keyFor = (email: string, purpose: OtpPurpose) => `auth:otp:${purpose}:${email}`;

export async function saveOtp(record: OtpRecord): Promise<void> {
  await getCache().set(keyFor(record.email, record.purpose), JSON.stringify(record), ttlSeconds);
}

export async function getOtp(email: string, purpose: OtpPurpose): Promise<OtpRecord | null> {
  const value = await getCache().get(keyFor(email, purpose));
  if (!value) return null;
  try {
    return JSON.parse(value) as OtpRecord;
  } catch {
    await deleteOtp(email, purpose);
    return null;
  }
}

export async function updateOtp(record: OtpRecord): Promise<void> {
  const remainingSeconds = Math.ceil((record.expiresAt - Date.now()) / 1000);
  if (remainingSeconds <= 0 || record.consumedAt) {
    await deleteOtp(record.email, record.purpose);
    return;
  }
  await getCache().set(keyFor(record.email, record.purpose), JSON.stringify(record), remainingSeconds);
}

export async function deleteOtp(email: string, purpose: OtpPurpose): Promise<void> {
  await getCache().del(keyFor(email, purpose));
}