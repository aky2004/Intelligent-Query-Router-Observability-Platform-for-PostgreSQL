import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { logger } from "../utils/logger";
interface EmailJob { to:string; subject:string; html:string }
const redisUrl=process.env.REDIS_URL;
const connection=redisUrl?new Redis(redisUrl,{maxRetriesPerRequest:null}):null;
const queue=connection?new Queue<EmailJob>("auth-email",{connection}):null;
async function deliver(job:EmailJob){
  const connectionKey=process.env.BREVO_API_KEY;
  if(!connectionKey){
    logger.warn("Brevo connection unavailable; email not delivered",{to:job.to});
    return;
  }
  const response=await fetch("https://api.brevo.com/v3/smtp/email",{
    method:"POST",
    headers:{
      "content-type":"application/json",
      "api-key":connectionKey
    },
    body:JSON.stringify({
      sender:{name:process.env.FROM_NAME??"Pg-admin",email:process.env.FROM_EMAIL??"noreply@example.com"},
      to:[{email:job.to}],
      subject:job.subject,
      htmlContent:job.html
    })
  });
  if(!response.ok)throw new Error(`Brevo delivery failed [${response.status}]: ${await response.text()}`);
}
if(connection)new Worker<EmailJob>("auth-email",async j=>deliver(j.data),{connection,concurrency:4}).on("failed",(job,error)=>logger.error("Email job failed",{jobId:job?.id,error:error.message}));
export async function queueOtpEmail(to:string,code:string,purpose:"verify_email"|"password_reset"){const action=purpose==="verify_email"?"verify your account":"reset your password";const job={to,subject:`${code} — ${action}`,html:`<div style="font-family:monospace;max-width:560px;margin:auto"><p>PG-ROUTER-AI / SECURITY</p><h1 style="font-size:36px">${code}</h1><p>Use this one-time code to ${action}. It expires in 10 minutes.</p><hr><small>If you did not request this, ignore this email.</small></div>`};if(queue)await queue.add(purpose,job,{jobId:`${purpose}-${to}-${Date.now()}`,attempts:4,backoff:{type:"exponential",delay:2000},removeOnComplete:100});else await deliver(job);}
