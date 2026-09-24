import { createHash, randomBytes, randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { appConfig } from "../config/app";
import { authRepository } from "./repository";

const accessTtl="15m"; const refreshMs=30*24*60*60*1000;
export const hashToken=(value:string)=>createHash("sha256").update(value).digest("hex");
const secret=()=>{if(appConfig.env==="production"&&appConfig.jwtSecret==="change-me")throw new Error("JWT_SECRET must be configured in production");return appConfig.jwtSecret;};
export const signAccessToken=(userId:string,role:string)=>jwt.sign({sub:userId,role,type:"access"},secret(),{expiresIn:accessTtl,issuer:"pg-router-ai",audience:"pg-router-ai-api"});
export const verifyAccessToken=(token:string)=>{const payload=jwt.verify(token,secret(),{issuer:"pg-router-ai",audience:"pg-router-ai-api"}) as jwt.JwtPayload;if(payload.type!=="access")throw new Error("Invalid token type");return payload;};
export async function issueRefresh(userId:string,familyId:string=randomUUID()){const raw=randomBytes(48).toString("base64url"),id=randomUUID();await authRepository.saveRefresh({id,userId,familyId,tokenHash:hashToken(raw),expiresAt:Date.now()+refreshMs,revokedAt:null,replacedBy:null});return {raw,id,familyId};}
export async function rotateRefresh(raw:string){const record=await authRepository.findRefresh(hashToken(raw));if(!record)throw new Error("Invalid refresh session");if(record.revokedAt){await authRepository.revokeFamily(record.familyId);throw new Error("Refresh token reuse detected");}if(record.expiresAt<Date.now())throw new Error("Refresh session expired");const next=await issueRefresh(record.userId,record.familyId);await authRepository.revokeRefresh(record.id,next.id);return {userId:record.userId,raw:next.raw};}
export const refreshCookie=(token:string,maxAge=refreshMs)=>`pg_refresh=${token}; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=${Math.floor(maxAge/1000)}${appConfig.env==="production"?"; Secure":""}`;
export const readRefreshCookie=(cookie:string|undefined)=>cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("pg_refresh="))?.slice(11)??null;
