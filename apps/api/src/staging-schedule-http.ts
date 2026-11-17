import type { FastifyInstance, FastifyReply } from "fastify";
import { publishStagingOwnerShift, PublishShiftFailure } from "../../../packages/domain-scheduling/src/publish-shift.js";
import { previewStagingAvailability, PreviewUnavailable, readPublishedShifts } from "../../../packages/domain-scheduling/src/staging-availability.js";
import { readStagingCapacity, StagingPublicationDenied } from "../../../packages/domain-entitlement/src/staging.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { validateLocalMinute } from "../../../packages/domain-scheduling/src/local-minute.js";
import { withTenantPermission } from "./protected-tenant-transaction.js";
import { verifyTenantActor } from "./session-context.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";

type Params={tenantId:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{16,128}$/;
function privateReply(reply:FastifyReply):void{
  reply.header("Cache-Control","no-store");
  reply.header("Pragma","no-cache");
  reply.header("Vary","Authorization");
}
function parsePublication(body:unknown){
  if(!body||typeof body!=="object"||Array.isArray(body))return null;
  const data=body as Record<string,unknown>;
  if(Object.keys(data).length!==2||typeof data.shiftId!=="string"||!UUID.test(data.shiftId)||
      !Number.isSafeInteger(data.expectedRevision)||(data.expectedRevision as number)<0||(data.expectedRevision as number)>=2147483647)return null;
  return {shiftId:data.shiftId,expectedRevision:data.expectedRevision as number};
}
function parseSelection(body:unknown){
  if(!body||typeof body!=="object"||Array.isArray(body))return null;
  const data=body as Record<string,unknown>;
  if(Object.keys(data).length!==4||typeof data.staffId!=="string"||!UUID.test(data.staffId)||
     typeof data.locationId!=="string"||!UUID.test(data.locationId)||
     typeof data.serviceId!=="string"||!UUID.test(data.serviceId)||typeof data.localDate!=="string")return null;
  try{validateLocalMinute(data.localDate+"T00:00");}catch{return null;}
  return {staffId:data.staffId,locationId:data.locationId,serviceId:data.serviceId,localDate:data.localDate};
}
export function registerStagingScheduleRoutes(app:FastifyInstance,{pool,verifier,enabled}:StagingPublicationDependencies):void{
  app.get<{Params:Params}>("/v1/organizations/:tenantId/staging-shifts",async(request,reply)=>{
    privateReply(reply);
    const verified=await verifyTenantActor(request.headers.authorization,request.params.tenantId,verifier);
    if(!verified.actor)return reply.code(verified.status).send({error:verified.error});
    try{
      return reply.send(await withTenantPermission(pool,verified.actor,"staging.availability.read",async client=>{
        const capacity=await readStagingCapacity(client,verified.actor!.tenantId,enabled);
        const result=await readPublishedShifts(client,verified.actor!.tenantId);
        return {...result,canPublish:capacity.state==="active"};
      }));
    }catch(error){return reply.code(error instanceof AuthorizationDeniedError?403:503).send({error:"unavailable"});}
  });
  if(!enabled)return;
  app.post<{Params:Params}>("/v1/organizations/:tenantId/staging-shifts",async(request,reply)=>{
    privateReply(reply);
    const verified=await verifyTenantActor(request.headers.authorization,request.params.tenantId,verifier);
    if(!verified.actor)return reply.code(verified.status).send({error:verified.error});
    const data=parsePublication(request.body);
    const key=request.headers["idempotency-key"];
    if(!data||typeof key!=="string"||!KEY.test(key))return reply.code(400).send({error:"invalid-request"});
    try{
      const shift=await publishStagingOwnerShift(pool,{...data,actor:verified.actor,idempotencyKey:key});
      return reply.send({shift});
    }catch(error){
      if(error instanceof AuthorizationDeniedError)return reply.code(403).send({error:"forbidden"});
      if(error instanceof StagingPublicationDenied)return reply.code(409).send({error:error.code});
      if(error instanceof PublishShiftFailure){
        if(error.code==="SHIFT_NOT_FOUND")return reply.code(404).send({error:"shift-unavailable"});
        return reply.code(409).send({error:error.code});
      }
      return reply.code(503).send({error:"unavailable"});
    }
  });
  app.get<{Params:Params}>("/v1/organizations/:tenantId/staging-availability",async(request,reply)=>{
    privateReply(reply);
    const verified=await verifyTenantActor(request.headers.authorization,request.params.tenantId,verifier);
    if(!verified.actor)return reply.code(verified.status).send({error:verified.error});
    const data=parseSelection(request.query);
    if(!data)return reply.code(400).send({error:"invalid-request"});
    try{
      return reply.send(await withTenantPermission(pool,verified.actor,"staging.availability.read",
        client=>previewStagingAvailability(client,verified.actor!.tenantId,data)));
    }catch(error){
      if(error instanceof AuthorizationDeniedError)return reply.code(403).send({error:"forbidden"});
      if(error instanceof PreviewUnavailable)return reply.code(409).send({error:"target-unavailable"});
      return reply.code(503).send({error:"unavailable"});
    }
  });
}
