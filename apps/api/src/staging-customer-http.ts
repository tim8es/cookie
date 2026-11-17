import type { FastifyInstance } from "fastify";
import { readStagingCustomerContext } from "../../../packages/domain-customers/src/staging-customer.js";
import { AuthorizationDeniedError } from "../../../packages/platform-identity/src/authorization.js";
import { verifyTenantActor } from "./session-context.js";
import type { StagingPublicationDependencies } from "./staging-publication-http.js";

export function registerStagingCustomerContext(app:FastifyInstance,{pool,verifier,enabled}:StagingPublicationDependencies):void{
  if(!enabled)return;
  app.get<{Params:{tenantId:string}}>("/v1/organizations/:tenantId/staging-customer-context",async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    reply.header("Pragma","no-cache");
    reply.header("Vary","Authorization");
    const verified=await verifyTenantActor(request.headers.authorization,request.params.tenantId,verifier);
    if(!verified.actor)return reply.code(verified.status).send({error:verified.error});
    if(Object.keys(request.query as object).length!==0)return reply.code(400).send({error:"invalid-request"});
    const client=await pool.connect().catch(()=>null);
    if(!client)return reply.code(503).send({error:"unavailable"});
    let discard=true;
    try{
      await client.query("BEGIN");discard=false;
      const context=await readStagingCustomerContext(client,verified.actor);
      discard=true;
      const result=await client.query("COMMIT");
      if(result.command!=="COMMIT")throw new Error("Context not committed");
      discard=false;
      return reply.send(context);
    }catch(error){
      if(!discard){
        discard=true;
        try{const result=await client.query("ROLLBACK");if(result.command==="ROLLBACK")discard=false;}catch{/* discard */}
      }
      return reply.code(error instanceof AuthorizationDeniedError&&!discard?403:503).send({error:error instanceof AuthorizationDeniedError&&!discard?"forbidden":"unavailable"});
    }finally{client.release(discard);}
  });
}
