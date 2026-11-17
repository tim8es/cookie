import type { VerifiedCustomerSession } from "./owner-auth";

const STATUSES = [
  "Confirmed",
  "CancelledByClient",
  "CancelledByBusiness",
  "Completed",
  "NoShow",
] as const;
type AppointmentStatus = (typeof STATUSES)[number];
export interface CustomerAppointment {
  readonly bookingId: string;
  readonly status: AppointmentStatus;
  readonly startAt: string;
  readonly endAt: string;
  readonly locationName: string;
  readonly staffName: string;
  readonly serviceName: string;
  readonly timeZone: string;
  readonly priceKopecks: string;
}
export interface CustomerAppointments {
  readonly appointments: CustomerAppointment[];
  readonly hasMore: boolean;
}
export class CustomerAppointmentsError extends Error {
  constructor(
    readonly reason:
      | "unauthorized"
      | "forbidden"
      | "unavailable"
      | "invalid-response",
  ) {
    super(reason);
  }
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function name(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 400
  );
}
function row(value: unknown): value is CustomerAppointment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<CustomerAppointment>;
  if (
    Object.keys(r).length !== 9 ||
    typeof r.bookingId !== "string" ||
    !UUID.test(r.bookingId) ||
    !r.status ||
    !STATUSES.includes(r.status) ||
    !instant(r.startAt) ||
    !instant(r.endAt) ||
    Date.parse(r.endAt) <= Date.parse(r.startAt) ||
    !name(r.locationName) ||
    !name(r.staffName) ||
    !name(r.serviceName) ||
    !name(r.timeZone) ||
    typeof r.priceKopecks !== "string" ||
    !/^(0|[1-9]\d{0,11})$/.test(r.priceKopecks)
  )
    return false;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: r.timeZone }).format();
    return true;
  } catch {
    return false;
  }
}
export async function readCustomerAppointments(
  session: VerifiedCustomerSession,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CustomerAppointments> {
  if (Date.now() / 1000 >= session.expiresAtUnixSeconds)
    throw new CustomerAppointmentsError("unauthorized");
  let response: Response;
  try {
    response = await fetcher(
      "/v1/organizations/" +
        session.tenantId +
        "/staging-customer-appointments",
      {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: { authorization: "Bearer " + session.accessToken },
      },
    );
  } catch {
    throw new CustomerAppointmentsError("unavailable");
  }
  if (response.status === 401)
    throw new CustomerAppointmentsError("unauthorized");
  if (response.status === 403) throw new CustomerAppointmentsError("forbidden");
  if (response.status !== 200)
    throw new CustomerAppointmentsError("unavailable");
  let data: unknown;
  try {
    data = (await response.json()) as unknown;
  } catch {
    throw new CustomerAppointmentsError("invalid-response");
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length !== 2
  )
    throw new CustomerAppointmentsError("invalid-response");
  const r = data as Partial<CustomerAppointments>;
  if (
    !Array.isArray(r.appointments) ||
    r.appointments.length > 200 ||
    !r.appointments.every(row) ||
    new Set(r.appointments.map((a) => a.bookingId)).size !==
      r.appointments.length ||
    typeof r.hasMore !== "boolean" ||
    (r.hasMore && r.appointments.length !== 200)
  )
    throw new CustomerAppointmentsError("invalid-response");
  return { appointments: r.appointments, hasMore: r.hasMore };
}
