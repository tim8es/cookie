/**
 * Frontend view models, NOT wire contracts.
 * Backend DTOs remain owned by #22 and must be mapped through an adapter.
 */
export type DemoBookingStatus = "demo-confirmed" | "demo-cancelled";
export type DataMode = "mock" | "api";
export type ViewState = "normal" | "empty" | "error" | "forbidden" | "conflict";

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}
export interface Location {
  id: string;
  organizationId: string;
  name: string;
  address: string;
}
export interface Service {
  id: string;
  organizationId: string;
  name: string;
  durationMinutes: number;
  basePriceRub: number;
}
export interface StaffMember {
  id: string;
  organizationId: string;
  displayName: string;
  positionTitle: string;
  serviceIds: string[];
}
export interface WorkSchedule {
  staffId: string;
  locationId: string;
  weekdays: number[];
  startsAt: string;
  endsAt: string;
}
export interface BookingView {
  id: string;
  organizationId: string;
  locationId: string;
  serviceId: string;
  staffId: string;
  date: string;
  time: string;
  clientAlias: string;
  status: DemoBookingStatus;
}
export interface DemoSnapshot {
  organization: Organization | null;
  locations: Location[];
  services: Service[];
  staff: StaffMember[];
  schedules: WorkSchedule[];
  bookings: BookingView[];
}
export interface CreateBookingDraft {
  locationId: string;
  serviceId: string;
  staffId: string;
  date: string;
  time: string;
  clientAlias: string;
}
export interface SlotView {
  time: string;
  label: string;
}
export type UiFailureCode =
  | "NOT_CONNECTED"
  | "SLOT_CONFLICT"
  | "NOT_FOUND"
  | "INVALID_DEMO_INPUT";
export class UiFailure extends Error {
  constructor(
    public readonly code: UiFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "UiFailure";
  }
}
export interface CookieUiPort {
  readonly mode: DataMode;
  getSnapshot(): Promise<DemoSnapshot>;
  createOrganization(name: string): Promise<Organization>;
  addLocation(name: string, address: string): Promise<Location>;
  addService(
    name: string,
    durationMinutes: number,
    basePriceRub: number,
  ): Promise<Service>;
  addStaff(
    displayName: string,
    positionTitle: string,
    serviceIds: string[],
  ): Promise<StaffMember>;
  saveSchedule(schedule: WorkSchedule): Promise<WorkSchedule>;
  getSlotSuggestions(
    staffId: string,
    locationId: string,
    date: string,
  ): Promise<SlotView[]>;
  createBooking(draft: CreateBookingDraft): Promise<BookingView>;
  /** Local synthetic booking actions only; not server commands. */
  cancelBooking(id: string): Promise<BookingView>;
  rescheduleBooking(
    id: string,
    date: string,
    time: string,
  ): Promise<BookingView>;
  resetDemo(): Promise<void>;
}
