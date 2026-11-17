import type { VerifiedCustomerSession } from "./owner-auth.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9._:-]{16,128}$/;
export interface ClientCancellationReceipt {
  readonly bookingId:string;
  readonly status:"CancelledByClient";
  readonly cancelledAt:string;
}
export class CancellationError extends Error {
  constructor(readonly reason:"denied"|"conflict"|"uncertain"){super(reason);}
}
function root(session:VerifiedCustomerSession):string {
  return "/v1/organizations/"+session.tenantId+"/staging-customer-cancellation";
}
const privacy={cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",redirect:"error"} as const;
function authorization(session:VerifiedCustomerSession):string {
  if(Date.now()/1000>=session.expiresAtUnixSeconds)throw new CancellationError("denied");
  return "Bearer "+session.accessToken;
}
export async function readCancellationCutoff(session:VerifiedCustomerSession,fetcher:typeof fetch=globalThis.fetch):Promise<number|null> {
  try {
    const response=await fetcher(root(session)+"/capability",{...privacy,method:"GET",headers:{authorization:authorization(session)}});
    if(response.status!==200)return null;
    const body:unknown=await response.json();
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||!("cutoffMinutes" in body)||
       typeof body.cutoffMinutes!=="number"||!Number.isSafeInteger(body.cutoffMinutes)||body.cutoffMinutes<0||body.cutoffMinutes>525600)return null;
    return body.cutoffMinutes;
  }catch{return null;}
}
export async function cancelOwnBooking(session:VerifiedCustomerSession,bookingId:string,key:string,fetcher:typeof fetch=globalThis.fetch):Promise<ClientCancellationReceipt>{
  if(!UUID.test(bookingId)||!KEY.test(key))throw new CancellationError("uncertain");
  const auth=authorization(session);
  let response:Response;
  try{
    response=await fetcher(root(session)+"/"+bookingId,{...privacy,method:"POST",headers:{authorization:auth,"content-type":"application/json","idempotency-key":key},body:"{}"});
  }catch{throw new CancellationError("uncertain");}
  if(response.status===401||response.status===403)throw new CancellationError("denied");
  const raw:unknown=await response.json().catch(()=>undefined);
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new CancellationError("uncertain");
  if([404,409].includes(response.status)&&Object.keys(raw).length===1&&"error" in raw&&
    ["BOOKING_NOT_FOUND","BOOKING_NOT_CONFIRMED","CANCELLATION_POLICY_DENIED"].includes(String(raw.error)))throw new CancellationError("conflict");
  if(response.status!==200||Object.keys(raw).length!==3||!("bookingId" in raw)||raw.bookingId!==bookingId||
    !("status" in raw)||raw.status!=="CancelledByClient"||!("cancelledAt" in raw)||typeof raw.cancelledAt!=="string"||
    !Number.isFinite(Date.parse(raw.cancelledAt))||new Date(raw.cancelledAt).toISOString()!==raw.cancelledAt)throw new CancellationError("uncertain");
  return {bookingId,status:"CancelledByClient",cancelledAt:raw.cancelledAt};
}
