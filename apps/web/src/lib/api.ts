import type {
  BookingView,
  CookieUiPort,
  DataMode,
  DemoSnapshot,
  Location,
  Organization,
  Service,
  SlotView,
  StaffMember,
  WorkSchedule,
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
    throw new UiFailure(
      "NOT_CONNECTED",
      "API ещё не подключён. Для локального UI включите VITE_COOKIE_DATA_MODE=mock.",
    );
  }
  async getSnapshot(): Promise<DemoSnapshot> {
    return this.unavailable();
  }
  async createOrganization(): Promise<Organization> {
    return this.unavailable();
  }
  async addLocation(): Promise<Location> {
    return this.unavailable();
  }
  async addService(): Promise<Service> {
    return this.unavailable();
  }
  async addStaff(): Promise<StaffMember> {
    return this.unavailable();
  }
  async saveSchedule(): Promise<WorkSchedule> {
    return this.unavailable();
  }
  async getSlotSuggestions(): Promise<SlotView[]> {
    return this.unavailable();
  }
  async createBooking(): Promise<BookingView> {
    return this.unavailable();
  }
  async cancelBooking(): Promise<BookingView> {
    return this.unavailable();
  }
  async rescheduleBooking(): Promise<BookingView> {
    return this.unavailable();
  }
  async resetDemo(): Promise<void> {
    return this.unavailable();
  }
}
export function createCookieUiApi(
  mode: DataMode = import.meta.env.VITE_COOKIE_DATA_MODE === "api"
    ? "api"
    : "mock",
): CookieUiPort {
  return mode === "mock" ? new MockCookieApi() : new NotConnectedApi();
}
