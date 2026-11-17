import type { FastifyInstance, FastifyReply } from "fastify";
import { cancelStagingCustomerBooking, CancelBookingFailure } from "../../../packages/domain-booking/src/index.js";
import { readStagingCustomerContext } from "../../../packages/domain-customers/src/index.js";
import { runSqlTransaction } from "../../../packages/platform-db/src/index.js";
import { AuthorizationDeniedError, requireTenantPermission } from "../../../packages/platform-identity/src/index.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";
import { verifyTenantActor } from "./session-context.js";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{16,128}$/;
export interface StagingCancellationDependencies extends StagingPublicationDependencies {
  readonly cutoffMinutes:number;
}
/** Undefined disables the entire route. Explicit operator config only. */
export function parseStagingCancellationCutoff(raw:string|undefined):number|undefined {
  if(raw===undefined)return undefined;
  if(!/^(0|[1-9]\d{0,5})$/.test(raw)||Number(raw)>525600)throw new Error("Invalid staging cancellation cutoff");
  return Number(raw);
}
function privacy(reply:FastifyReply){
  reply.header("Cache-Control","no-store");reply.header("Pragma","no-cache");reply.header("Vary","Authorization");
}
export function registerStagingCustomerCancellation(app:FastifyInstance,{pool,verifier,enabled,cutoffMinutes}:StagingCancellationDependencies):void{
  if(!enabled)return;
  if(!Number.isSafeInteger(cutoffMinutes)||cutoffMinutes<0||cutoffMinutes>525600)throw new Error("Invalid staging cancellation dependency");
  app.get<{Params:{tenantId:string}}>("/v1/organizations/:tenantId/staging-customer-cancellation/capability",async(req,reply)=>{
    privacy(reply);
    const verified=await verifyTenantActor(req.headers.authorization,req.params.tenantId,verifier);
    if(!verified.actor)return reply.code(verified.status).send({error:verified.error});
    if(Object.keys(req.query as object).length!==0)return reply.code(400).send({error:"invalid-request"});
    const actor=verified.actor;
    try{
      await runSqlTransaction(pool,async client=>{
        await readStagingCustomerContext(client,actor);
        await requireTenantPermission(client,actor,{kind:"customer-self",tenantId:actor.tenantId,clientIdentityId:actor.identityId},"staging.customer.booking.cancel");
      });
      return reply.send({cutoffMinutes});
    }catch(error){
      if(error instanceof AuthorizationDeniedError)return reply.code(403).send({error:"forbidden"});
      return reply.code(503).send({error:"unavailable"});
    }
  });
  app.post<{Params:{tenantId:string;bookingId:string}}>("/v1/organizations/:tenantId/staging-customer-cancellation/:bookingId",async(req,reply)=>{
    privacy(reply);
    const verified=await verifyTenantActor(req.headers.authorization,req.params.tenantId,verifier);
    if(!verified.actor)return reply.code(verified.status).send({error:verified.error});
    const key=req.headers["idempotency-key"];
    if(!UUID.test(req.params.bookingId)||typeof key!=="string"||!KEY.test(key)||Object.keys(req.query as object).length!==0||
       !req.body||typeof req.body!=="object"||Array.isArray(req.body)||Object.keys(req.body).length!==0)
      return reply.code(400).send({error:"invalid-request"});
    try{
      return reply.send(await cancelStagingCustomerBooking(pool,{actor:verified.actor,bookingId:req.params.bookingId,idempotencyKey:key},cutoffMinutes));
    }catch(error){
      if(error instanceof AuthorizationDeniedError)return reply.code(403).send({error:"forbidden"});
      if(error instanceof CancelBookingFailure){
        const code=error.code==="INVALID_CANCELLATION_COMMAND"?400:error.code==="BOOKING_NOT_FOUND"?404:409;
        return reply.code(code).send({error:error.code});
      }
      return reply.code(503).send({error:"unavailable"});
    }
  });
}
