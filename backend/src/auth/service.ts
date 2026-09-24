import bcrypt from "bcryptjs";
import { createHash, randomInt, randomUUID } from "crypto";
import { authRepository } from "./repository";
import type { OtpPurpose } from "./types";
import { hashToken, issueRefresh, rotateRefresh, signAccessToken } from "./tokens";
import { queueOtpEmail } from "../jobs/email-queue";
import { deleteOtp, getOtp, saveOtp, updateOtp } from "./otp-store";
import { AppError } from "../utils/errors";
const normalize=(email:string)=>email.trim().toLowerCase();
const hashCode=(id:string,code:string)=>createHash("sha256").update(`${id}:${code}`).digest("hex");
const invalidCode=()=>new AppError("Invalid or expired code","INVALID_OTP",400);
export async function requestSignup(email:string,password:string,displayName:string){email=normalize(email);if(await authRepository.findUserByEmail(email))return;const passwordHash=await bcrypt.hash(password,12);await createOtp(email,"verify_email",{passwordHash,displayName});}
export async function requestReset(email:string){email=normalize(email);if(await authRepository.findUserByEmail(email))await createOtp(email,"password_reset",{});}
async function createOtp(email:string,purpose:OtpPurpose,payload:Record<string,unknown>){const id=randomUUID(),code=String(randomInt(100000,1000000));await saveOtp({id,email,purpose,codeHash:hashCode(id,code),payload,attempts:0,expiresAt:Date.now()+600000,consumedAt:null});await queueOtpEmail(email,code,purpose);}
async function consumeOtp(email:string,code:string,purpose:OtpPurpose){const normalized=normalize(email),otp=await getOtp(normalized,purpose);if(!otp||otp.expiresAt<Date.now()||otp.attempts>=5)throw invalidCode();otp.attempts+=1;if(hashCode(otp.id,code)!==otp.codeHash){await updateOtp(otp);throw invalidCode();}await deleteOtp(normalized,purpose);return otp;}
export async function verifySignup(email:string,code:string){const otp=await consumeOtp(email,code,"verify_email");let user=await authRepository.findUserByEmail(normalize(email));if(!user)user=await authRepository.createUser({email:normalize(email),passwordHash:String(otp.payload.passwordHash),displayName:String(otp.payload.displayName)});return createSession(user);}
export async function login(email:string,password:string){const user=await authRepository.findUserByEmail(normalize(email));if(!user||!await bcrypt.compare(password,user.passwordHash))throw new AppError("Invalid email or password","INVALID_CREDENTIALS",401);return createSession(user);}
export async function refresh(raw:string){try{const rotated=await rotateRefresh(raw),user=await authRepository.findUserById(rotated.userId);if(!user)throw new Error("Account not found");return {accessToken:signAccessToken(user.id,user.role),refreshToken:rotated.raw,user:safeUser(user)};}catch{throw new AppError("Invalid or expired refresh session","INVALID_REFRESH",401);}}
export async function logout(raw:string|undefined){if(!raw)return;const session=await authRepository.findRefresh(hashToken(raw));if(session)await authRepository.revokeFamily(session.familyId);}
export async function resetPassword(email:string,code:string,password:string){const otp=await consumeOtp(email,code,"password_reset"),user=await authRepository.findUserByEmail(otp.email);if(!user)throw new Error("Invalid or expired code");await authRepository.updatePassword(user.id,await bcrypt.hash(password,12));return createSession({...user,passwordHash:""});}
async function createSession(user:Awaited<ReturnType<typeof authRepository.findUserById>> & {}){if(!user)throw new Error("Account not found");const r=await issueRefresh(user.id);return {accessToken:signAccessToken(user.id,user.role),refreshToken:r.raw,user:safeUser(user)};}
const safeUser=(u:NonNullable<Awaited<ReturnType<typeof authRepository.findUserById>>>)=>({id:u.id,email:u.email,displayName:u.displayName,avatarUrl:u.avatarUrl,preferences:u.preferences,role:u.role});
