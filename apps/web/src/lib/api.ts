import type {
  BookingView,
  CookieUiPort,
  DataMode,
  DemoSnapshot,
  Location,
  Organization,
  Service,
  SalonAppearance,
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
      "Этот демонстрационный адаптер недоступен в рабочем режиме. Для просмотра демо откройте /demo.",
    );
  }
  async getSnapshot(): Promise<DemoSnapshot> {
    return this.unavailable();
  }
  async createOrganization(): Promise<Organization> {
    return this.unavailable();
  }
  async saveAppearance(): Promise<SalonAppearance> {
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
/** Root and unknown paths always fail closed into API mode. Only an explicit demo path opts in. */
export function resolveCookieDataMode(pathname: string): DataMode {
  return pathname === "/demo" || pathname === "/demo/" ? "mock" : "api";
}

export function createCookieUiApi(
  mode: DataMode = resolveCookieDataMode(globalThis.location?.pathname ?? "/"),
): CookieUiPort {
  return mode === "mock" ? new MockCookieApi() : new NotConnectedApi();
}
