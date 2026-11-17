import type { VerifiedOwnerSession } from "./owner-auth";
import type { ShiftPlan } from "./shift-plans-api";

export type PublishedShift = Omit<ShiftPlan,"active"|"revision"> & {readonly active:true};
export interface ScheduleStatus {readonly shifts:PublishedShift[];readonly hasMore:boolean;readonly canPublish:boolean}
export interface PreviewSelection {
  readonly staffId:string;readonly locationId:string;readonly serviceId:string;readonly localDate:string;
}
export interface PreviewSlot {readonly startAt:string;readonly endAt:string;readonly occupiedUntil:string}
export interface SlotPreview {readonly localDate:string;readonly timeZone:string;readonly slots:PreviewSlot[]}
export class StagingScheduleError extends Error {
  constructor(readonly reason:string){super(reason);}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function instant(value:unknown):value is string{
  return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
}
function isShift(value:unknown):value is PublishedShift{
  if(!value||typeof value!=="object")return false;
  const s=value as Partial<PublishedShift>;
  return typeof s.shiftId==="string"&&UUID.test(s.shiftId)&&typeof s.staffId==="string"&&UUID.test(s.staffId)&&
    typeof s.locationId==="string"&&UUID.test(s.locationId)&&instant(s.startAt)&&instant(s.endAt)&&Date.parse(s.endAt)>Date.parse(s.startAt)&&s.active===true;
}
function isSlot(value:unknown):value is PreviewSlot{
  if(!value||typeof value!=="object")return false;
  const s=value as Partial<PreviewSlot>;
  return instant(s.startAt)&&instant(s.endAt)&&instant(s.occupiedUntil)&&Date.parse(s.endAt)>Date.parse(s.startAt)&&Date.parse(s.occupiedUntil)>=Date.parse(s.endAt);
}
async function request(session:VerifiedOwnerSession,path:string,init:RequestInit,fetcher:typeof fetch):Promise<unknown>{
  if(Date.now()/1000>=session.expiresAtUnixSeconds)throw new StagingScheduleError("unauthorized");
  let response:Response;
  try{response=await fetcher("/v1/organizations/"+session.tenantId+path,{
    ...init,credentials:"omit",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer",
    headers:{...(init.headers as Record<string,string>),authorization:"Bearer "+session.accessToken},
  });}catch{throw new StagingScheduleError("unavailable");}
  if(response.status===401||response.status===403)throw new StagingScheduleError("unauthorized");
  if(response.status===404)throw new StagingScheduleError("shift-unavailable");
  if(response.status===400)throw new StagingScheduleError("invalid-request");
  if(response.status===409){
    const data:unknown=await response.json().catch(()=>null);
    if(data&&typeof data==="object"&&"error" in data&&typeof data.error==="string")
      throw new StagingScheduleError(data.error);
    throw new StagingScheduleError("conflict");
  }
  if(response.status!==200)throw new StagingScheduleError("unavailable");
  try{return await response.json() as unknown;}catch{throw new StagingScheduleError("invalid-response");}
}
export async function readStagingSchedule(session:VerifiedOwnerSession,fetcher:typeof fetch=globalThis.fetch):Promise<ScheduleStatus>{
  const body=await request(session,"/staging-shifts",{method:"GET"},fetcher);
  if(!body||typeof body!=="object")throw new StagingScheduleError("invalid-response");
  const s=body as Partial<ScheduleStatus>;
  if(!Array.isArray(s.shifts)||s.shifts.length>200||!s.shifts.every(isShift)||new Set(s.shifts.map(w=>w.shiftId)).size!==s.shifts.length||
     typeof s.hasMore!=="boolean"||typeof s.canPublish!=="boolean")throw new StagingScheduleError("invalid-response");
  return {shifts:s.shifts,hasMore:s.hasMore,canPublish:s.canPublish};
}
export async function publishStagingShift(session:VerifiedOwnerSession,plan:ShiftPlan,key:string,fetcher:typeof fetch=globalThis.fetch):Promise<PublishedShift>{
  if(!UUID.test(key)||!UUID.test(plan.shiftId)||!Number.isSafeInteger(plan.revision)||plan.revision<0)
    throw new StagingScheduleError("invalid-response");
  const body=await request(session,"/staging-shifts",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key},
    body:JSON.stringify({shiftId:plan.shiftId,expectedRevision:plan.revision})},fetcher);
  const shift=body&&typeof body==="object"&&"shift" in body?body.shift:null;
  if(!isShift(shift)||shift.shiftId!==plan.shiftId||shift.staffId!==plan.staffId||shift.locationId!==plan.locationId||
      shift.startAt!==plan.startAt||shift.endAt!==plan.endAt)throw new StagingScheduleError("invalid-response");
  return shift;
}
export async function previewStagingSlots(session:VerifiedOwnerSession,selection:PreviewSelection,fetcher:typeof fetch=globalThis.fetch):Promise<SlotPreview>{
  if(!UUID.test(selection.staffId)||!UUID.test(selection.locationId)||!UUID.test(selection.serviceId)||!/^\d{4}-\d{2}-\d{2}$/.test(selection.localDate))
    throw new StagingScheduleError("invalid-request");
  const params=new URLSearchParams({...selection});
  const body=await request(session,"/staging-availability?"+params.toString(),{method:"GET"},fetcher);
  if(!body||typeof body!=="object")throw new StagingScheduleError("invalid-response");
  const s=body as Partial<SlotPreview>;
  if(s.localDate!==selection.localDate||typeof s.timeZone!=="string"||!Array.isArray(s.slots)||s.slots.length>1500||
    !s.slots.every(isSlot)||new Set(s.slots.map(slot=>slot.startAt)).size!==s.slots.length)throw new StagingScheduleError("invalid-response");
  try{new Intl.DateTimeFormat("ru-RU",{timeZone:s.timeZone}).format();}catch{throw new StagingScheduleError("invalid-response");}
  return {localDate:s.localDate,timeZone:s.timeZone,slots:s.slots};
}
