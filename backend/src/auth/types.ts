export type OtpPurpose = "verify_email" | "password_reset";
export interface UserRecord { id: string; email: string; passwordHash: string; verified: boolean; displayName: string; avatarUrl: string | null; preferences: Record<string, unknown>; role: "admin" | "operator" | "viewer" }
export interface OtpRecord { id: string; email: string; purpose: OtpPurpose; codeHash: string; payload: Record<string, unknown>; attempts: number; expiresAt: number; consumedAt: number | null }
export interface RefreshRecord { id: string; userId: string; familyId: string; tokenHash: string; expiresAt: number; revokedAt: number | null; replacedBy: string | null }
