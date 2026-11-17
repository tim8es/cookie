import type { VerifiedCustomerSession } from "./owner-auth";
export interface CustomerOffer {
  readonly locationId:string;readonly locationName:string;readonly staffId:string;readonly staffName:string;
  readonly serviceId:string;readonly serviceName:string;readonly timeZone:string;readonly durationMinutes:number;readonly basePriceKopecks:string;
}
export interface CustomerSlot {readonly startAt:string;readonly endAt:string}
export interface CustomerSlots {readonly localDate:string;readonly timeZone:string;readonly slots:CustomerSlot[]}
export class CustomerOffersError extends Error {
  constructor(readonly reason:"unauthorized"|"unavailable"|"invalid-response"|"target-unavailable"){super(reason);}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function zone(value:unknown):value is string{
  if(typeof value!=="string"||value.length>100)return false;
  try{new Intl.DateTimeFormat("ru-RU",{timeZone:value}).format();return true;}catch{return false;}
}
function id(value:unknown):value is string{return typeof value==="string"&&UUID.test(value);}
function name(value:unknown):value is string{return typeof value==="string"&&value.trim().length>0&&value.length<=400;}
function isOffer(value:unknown):value is CustomerOffer{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const o=value as Partial<CustomerOffer>;
  return Object.keys(o).length===9&&id(o.locationId)&&id(o.staffId)&&id(o.serviceId)&&
    name(o.locationName)&&name(o.staffName)&&name(o.serviceName)&&zone(o.timeZone)&&
    Number.isInteger(o.durationMinutes)&&o.durationMinutes!>=1&&o.durationMinutes!<=1440&&
    typeof o.basePriceKopecks==="string"&&/^(0|[1-9]\d{0,11})$/.test(o.basePriceKopecks);
}
function instant(value:unknown):value is string{
  return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
}
function isSlot(value:unknown):value is CustomerSlot{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const s=value as Partial<CustomerSlot>;
  return Object.keys(s).length===2&&instant(s.startAt)&&instant(s.endAt)&&Date.parse(s.endAt)>Date.parse(s.startAt);
}
async function get(session:VerifiedCustomerSession,path:string,fetcher:typeof fetch):Promise<unknown>{
  if(Date.now()/1000>=session.expiresAtUnixSeconds)throw new CustomerOffersError("unauthorized");
  let response:Response;
  try{response=await fetcher("/v1/organizations/"+session.tenantId+path,{
    method:"GET",credentials:"omit",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",
    headers:{authorization:"Bearer "+session.accessToken},
  });}catch{throw new CustomerOffersError("unavailable");}
  if(response.status===401||response.status===403)throw new CustomerOffersError("unauthorized");
  if(response.status===409)throw new CustomerOffersError("target-unavailable");
  if(response.status!==200)throw new CustomerOffersError("unavailable");
  try{return await response.json() as unknown;}catch{throw new CustomerOffersError("invalid-response");}
}
export async function readCustomerOffers(session:VerifiedCustomerSession,fetcher:typeof fetch=globalThis.fetch):Promise<CustomerOffer[]>{
  const data=await get(session,"/staging-customer-offers",fetcher);
  if(!data||typeof data!=="object"||!("offers" in data)||!Array.isArray(data.offers)||data.offers.length>200||
     !data.offers.every(isOffer)||new Set(data.offers.map(o=>o.locationId+":"+o.serviceId+":"+o.staffId)).size!==data.offers.length)
    throw new CustomerOffersError("invalid-response");
  return data.offers;
}
export async function readCustomerSlots(session:VerifiedCustomerSession,offer:CustomerOffer,date:string,fetcher:typeof fetch=globalThis.fetch):Promise<CustomerSlots>{
  if(!isOffer(offer)||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new CustomerOffersError("invalid-response");
  const params=new URLSearchParams({locationId:offer.locationId,serviceId:offer.serviceId,staffId:offer.staffId,localDate:date});
  const data=await get(session,"/staging-customer-slots?"+params.toString(),fetcher);
  if(!data||typeof data!=="object")throw new CustomerOffersError("invalid-response");
  const s=data as Partial<CustomerSlots>;
  if(s.localDate!==date||!zone(s.timeZone)||s.timeZone!==offer.timeZone||!Array.isArray(s.slots)||
     s.slots.length>1500||!s.slots.every(isSlot)||new Set(s.slots.map(slot=>slot.startAt)).size!==s.slots.length)
    throw new CustomerOffersError("invalid-response");
  return {localDate:s.localDate,timeZone:s.timeZone,slots:s.slots};
}
