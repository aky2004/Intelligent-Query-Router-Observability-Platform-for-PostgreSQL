import { Pool } from "pg";
import { databaseConfig } from "../config/database";
import type { RefreshRecord, UserRecord } from "./types";

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(input: { email: string; passwordHash: string; displayName: string }): Promise<UserRecord>;
  updatePassword(userId: string, passwordHash: string): Promise<void>;
  saveRefresh(record: RefreshRecord): Promise<void>;
  findRefresh(tokenHash: string): Promise<RefreshRecord | null>;
  revokeRefresh(id: string, replacedBy?: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
}

const users = new Map<string, UserRecord>();
const refreshes = new Map<string, RefreshRecord>();
class MemoryAuthRepository implements AuthRepository {
  async findUserByEmail(email: string) { return [...users.values()].find(u => u.email === email) ?? null; }
  async findUserById(id: string) { return users.get(id) ?? null; }
  async createUser(input: { email: string; passwordHash: string; displayName: string }) { const id=crypto.randomUUID(); const user:UserRecord={id,email:input.email,passwordHash:input.passwordHash,verified:true,displayName:input.displayName,avatarUrl:null,preferences:{},role:"viewer"}; users.set(id,user); return user; }
  async updatePassword(userId:string,passwordHash:string){const u=users.get(userId);if(u)users.set(userId,{...u,passwordHash});}
  async saveRefresh(record:RefreshRecord){refreshes.set(record.id,record);}
  async findRefresh(tokenHash:string){return [...refreshes.values()].find(r=>r.tokenHash===tokenHash)??null;}
  async revokeRefresh(id:string,replacedBy?:string){const r=refreshes.get(id);if(r)refreshes.set(id,{...r,revokedAt:Date.now(),replacedBy:replacedBy??null});}
  async revokeFamily(familyId:string){for(const [id,r] of refreshes)if(r.familyId===familyId)refreshes.set(id,{...r,revokedAt:Date.now()});}
}

class PgAuthRepository implements AuthRepository {
  private pool=new Pool({connectionString:databaseConfig.nodes.find(n=>n.role==="primary")?.connectionString,max:5});
  async findUserByEmail(email:string){const r=await this.pool.query(`SELECT u.id,u.email,u.password_hash,u.email_verified_at,p.display_name,p.avatar_url,p.preferences,COALESCE((SELECT role FROM user_roles WHERE user_id=u.id ORDER BY role LIMIT 1),'viewer') role FROM app_users u JOIN profiles p ON p.user_id=u.id WHERE u.email=$1`,[email]);return this.mapUser(r.rows[0]);}
  async findUserById(id:string){const r=await this.pool.query(`SELECT u.id,u.email,u.password_hash,u.email_verified_at,p.display_name,p.avatar_url,p.preferences,COALESCE((SELECT role FROM user_roles WHERE user_id=u.id ORDER BY role LIMIT 1),'viewer') role FROM app_users u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`,[id]);return this.mapUser(r.rows[0]);}
  private mapUser(row:Record<string,unknown>|undefined):UserRecord|null{return row?{id:String(row.id),email:String(row.email),passwordHash:String(row.password_hash),verified:Boolean(row.email_verified_at),displayName:String(row.display_name),avatarUrl:row.avatar_url?String(row.avatar_url):null,preferences:(row.preferences??{}) as Record<string,unknown>,role:row.role as UserRecord["role"]}:null;}
  async createUser(input:{email:string;passwordHash:string;displayName:string}){const c=await this.pool.connect();try{await c.query("BEGIN");const u=await c.query(`INSERT INTO app_users(email,password_hash,email_verified_at) VALUES($1,$2,now()) RETURNING id`,[input.email,input.passwordHash]);const row=u.rows[0];if(!row)throw new Error("Account creation failed");const id=String(row.id);await c.query(`INSERT INTO profiles(user_id,display_name) VALUES($1,$2)`,[id,input.displayName]);await c.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'viewer')`,[id]);await c.query("COMMIT");const user=await this.findUserById(id);if(!user)throw new Error("Account creation failed");return user;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
  async updatePassword(userId:string,passwordHash:string){await this.pool.query(`UPDATE app_users SET password_hash=$2,updated_at=now() WHERE id=$1`,[userId,passwordHash]);}
  async saveRefresh(r:RefreshRecord){await this.pool.query(`INSERT INTO refresh_sessions(id,user_id,family_id,token_hash,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))`,[r.id,r.userId,r.familyId,r.tokenHash,r.expiresAt]);}
  async findRefresh(hash:string){const q=await this.pool.query(`SELECT id,user_id,family_id,token_hash,extract(epoch from expires_at)*1000 expires_at,extract(epoch from revoked_at)*1000 revoked_at,replaced_by FROM refresh_sessions WHERE token_hash=$1`,[hash]);const r=q.rows[0];return r?{id:r.id,userId:r.user_id,familyId:r.family_id,tokenHash:r.token_hash,expiresAt:Number(r.expires_at),revokedAt:r.revoked_at?Number(r.revoked_at):null,replacedBy:r.replaced_by}:null;}
  async revokeRefresh(id:string,replacedBy?:string){await this.pool.query(`UPDATE refresh_sessions SET revoked_at=now(),replaced_by=$2 WHERE id=$1`,[id,replacedBy??null]);}
  async revokeFamily(familyId:string){await this.pool.query(`UPDATE refresh_sessions SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL`,[familyId]);}
}
export const authRepository:AuthRepository=databaseConfig.simulate?new MemoryAuthRepository():new PgAuthRepository();
