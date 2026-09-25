import { devAuthBypass, verifyFirebaseToken } from "../../auth/firebase";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { login, logout, refresh, requestReset, requestSignup, resetPassword, verifySignup } from "../../auth/service";
import { readRefreshCookie, refreshCookie, verifyAccessToken } from "../../auth/tokens";
import { authRepository } from "../../auth/repository";
import { fail, ok } from "../response";
const email=z.string().email().max(254),password=z.string().min(10).max(128),code=z.string().regex(/^\d{6}$/);
const schemas={signup:z.object({email,password,displayName:z.string().min(2).max(80)}),verify:z.object({email,code}),login:z.object({email,password}),resetRequest:z.object({email}),reset:z.object({email,code,password})};
export const authRouter=Router();
const generic={message:"If the address is eligible, a one-time code is on its way."};
authRouter.post("/auth/signup",async(req,res,next)=>{try{const d=schemas.signup.parse(req.body);await requestSignup(d.email,d.password,d.displayName);ok(res,generic);}catch(e){next(e);}});
authRouter.post("/auth/verify",async(req,res,next)=>{try{const d=schemas.verify.parse(req.body),s=await verifySignup(d.email,d.code);res.setHeader("Set-Cookie",refreshCookie(s.refreshToken));ok(res,{accessToken:s.accessToken,user:s.user});}catch(e){next(e);}});
authRouter.post("/auth/login",async(req,res,next)=>{try{const d=schemas.login.parse(req.body),s=await login(d.email,d.password);res.setHeader("Set-Cookie",refreshCookie(s.refreshToken));ok(res,{accessToken:s.accessToken,user:s.user});}catch(e){next(e);}});
authRouter.post("/auth/refresh",async(req,res,next)=>{try{const raw=readRefreshCookie(req.headers.cookie);if(!raw)return fail(res,401,"UNAUTHORIZED","No refresh session");const s=await refresh(raw);res.setHeader("Set-Cookie",refreshCookie(s.refreshToken));ok(res,{accessToken:s.accessToken,user:s.user});}catch(e){next(e);}});
authRouter.post("/auth/logout",async(req,res,next)=>{try{const raw=readRefreshCookie(req.headers.cookie);await logout(raw??undefined);res.setHeader("Set-Cookie",refreshCookie("",0));ok(res,{signedOut:true});}catch(e){next(e);}});
authRouter.post("/auth/password/request",async(req,res,next)=>{try{const d=schemas.resetRequest.parse(req.body);await requestReset(d.email);ok(res,generic);}catch(e){next(e);}});
authRouter.post("/auth/password/reset",async(req,res,next)=>{try{const d=schemas.reset.parse(req.body),s=await resetPassword(d.email,d.code,d.password);res.setHeader("Set-Cookie",refreshCookie(s.refreshToken));ok(res,{accessToken:s.accessToken,user:s.user});}catch(e){next(e);}});
export interface AuthRequest extends Request { userId?:string }
export async function requireAuth(req:AuthRequest,res:Response,next:NextFunction){try{const token=req.headers.authorization?.replace(/^Bearer\s+/i,"");if(devAuthBypass()){req.userId="dev-user";return next();}if(!token)return fail(res,401,"UNAUTHORIZED","Access token required");const hosted=await verifyFirebaseToken(token);if(hosted){req.userId=hosted.userId;return next();}const payload=verifyAccessToken(token);if(typeof payload.sub!=="string"||!await authRepository.findUserById(payload.sub))return fail(res,401,"UNAUTHORIZED","Invalid access token");req.userId=payload.sub;next();}catch{return fail(res,401,"UNAUTHORIZED","Invalid or expired access token");}}
authRouter.get("/auth/me",requireAuth,async(req:AuthRequest,res)=>{const user=await authRepository.findUserById(req.userId??"");if(!user)return fail(res,404,"NOT_FOUND","Account not found");ok(res,{id:user.id,email:user.email,displayName:user.displayName,avatarUrl:user.avatarUrl,preferences:user.preferences,role:user.role});});
