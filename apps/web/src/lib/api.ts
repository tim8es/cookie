import type {
  BookingView, CookieUiPort, CreateBookingDraft, DataMode, DemoSnapshot,
  Location, Organization, Service, SlotView, StaffMember, WorkSchedule,
} from "./model";
import { UiFailure } from "./model";
import { MockCookieApi } from "./mock";

/**
 * API mode is intentionally fail-closed until #22 defines stable DTOs and
 * authentication. Do not invent endpoints or re-use server-internal models.
 */
class NotConnectedApi implements CookieUiPort {
  readonly mode: DataMode = "api";
  private unavailable(): never {
    throw new UiFailure("NOT_CONNECTED", "API ещё не подключён. Для локального UI включите VITE_COOKIE_DATA_MODE=mock.");
  }
  async getSnapshot(): Promise<DemoSnapshot> { return this.unavailable(); }
  async createOrganization(_name: string): Promise<Organization> { return this.unavailable(); }
  async addLocation(_name: string, _address: string): Promise<Location> { return this.unavailable(); }
  async addService(_name: string, _duration: number, _price: number): Promise<Service> { return this.unavailable(); }
  async addStaff(_name: string, _title: string, _serviceIds: string[]): Promise<StaffMember> { return this.unavailable(); }
  async saveSchedule(_schedule: WorkSchedule): Promise<WorkSchedule> { return this.unavailable(); }
  async getSlotSuggestions(_staffId: string, _locationId: string, _date: string): Promise<SlotView[]> { return this.unavailable(); }
  async createBooking(_draft: CreateBookingDraft): Promise<BookingView> { return this.unavailable(); }
  async resetDemo(): Promise<void> { return this.unavailable(); }
}
export function createCookieUiApi(mode: DataMode = import.meta.env.VITE_COOKIE_DATA_MODE === "api" ? "api" : "mock"): CookieUiPort {
  return mode === "mock" ? new MockCookieApi() : new NotConnectedApi();
}
