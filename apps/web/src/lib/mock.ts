import type {
  BookingView,
  CookieUiPort,
  CreateBookingDraft,
  DemoSnapshot,
  Location,
  Organization,
  Service,
  SlotView,
  StaffMember,
  WorkSchedule,
} from "./model";
import { UiFailure } from "./model";
import { parseDay } from "./dates";

export interface DemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const STORAGE_KEY = "cookie.frontend-demo.v1";
const empty = (): DemoSnapshot => ({
  organization: null,
  locations: [],
  services: [],
  staff: [],
  schedules: [],
  bookings: [],
});
const makeId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `demo-${Math.random().toString(36).slice(2)}`;
const DEMO_SUGGESTIONS = ["10:00", "12:00", "15:00"];

function storageFromBrowser(): DemoStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Synthetic, session-local UI adapter. This is intentionally NOT a booking engine.
 * Suggested times are fixture values, NOT computed availability.
 */
export class MockCookieApi implements CookieUiPort {
  readonly mode = "mock" as const;
  private snapshot: DemoSnapshot;

  constructor(
    private readonly storage: DemoStorage | undefined = storageFromBrowser(),
  ) {
    try {
      const cached = storage?.getItem(STORAGE_KEY);
      this.snapshot = cached ? (JSON.parse(cached) as DemoSnapshot) : empty();
    } catch {
      this.snapshot = empty();
    }
  }

  private persist(): void {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
  }

  private requireOrganization(): Organization {
    if (!this.snapshot.organization)
      throw new UiFailure("NOT_FOUND", "Сначала создайте тестовую организацию.");
    return this.snapshot.organization;
  }

  async getSnapshot(): Promise<DemoSnapshot> {
    return structuredClone(this.snapshot);
  }

  async createOrganization(name: string): Promise<Organization> {
    if (!name.trim())
      throw new UiFailure(
        "INVALID_DEMO_INPUT",
        "Введите название тестового салона.",
      );
    if (this.snapshot.organization)
      throw new UiFailure(
        "INVALID_DEMO_INPUT",
        "Демо-организация уже существует.",
      );
    const org: Organization = {
      id: makeId(),
      name: name.trim(),
      createdAt: new Date().toISOString(),
    };
    this.snapshot.organization = org;
    this.snapshot.locations.push({
      id: makeId(),
      organizationId: org.id,
      name: "Основной филиал (демо)",
      address: "Демонстрационный адрес",
    });
    this.persist();
    return org;
  }

  async addLocation(name: string, address: string): Promise<Location> {
    const org = this.requireOrganization();
    if (!name.trim())
      throw new UiFailure("INVALID_DEMO_INPUT", "Укажите название филиала.");
    const location = {
      id: makeId(),
      organizationId: org.id,
      name: name.trim(),
      address: address.trim() || "Адрес не указан",
    };
    this.snapshot.locations.push(location);
    this.persist();
    return location;
  }

  async addService(
    name: string,
    durationMinutes: number,
    basePriceRub: number,
  ): Promise<Service> {
    const org = this.requireOrganization();
    if (
      !name.trim() ||
      !Number.isFinite(durationMinutes) ||
      durationMinutes <= 0 ||
      !Number.isFinite(basePriceRub) ||
      basePriceRub < 0
    ) {
      throw new UiFailure(
        "INVALID_DEMO_INPUT",
        "Проверьте название, длительность и базовую цену.",
      );
    }
    const service = {
      id: makeId(),
      organizationId: org.id,
      name: name.trim(),
      durationMinutes,
      basePriceRub,
    };
    this.snapshot.services.push(service);
    this.persist();
    return service;
  }

  async addStaff(
    displayName: string,
    positionTitle: string,
    serviceIds: string[],
  ): Promise<StaffMember> {
    const org = this.requireOrganization();
    if (
      !displayName.trim() ||
      serviceIds.length === 0 ||
      serviceIds.some(
        (id) => !this.snapshot.services.some((service) => service.id === id),
      )
    ) {
      throw new UiFailure(
        "INVALID_DEMO_INPUT",
        "Укажите имя и хотя бы одну существующую услугу.",
      );
    }
    const staff: StaffMember = {
      id: makeId(),
      organizationId: org.id,
      displayName: displayName.trim(),
      positionTitle: positionTitle.trim() || "Мастер",
      serviceIds: [...serviceIds],
    };
    this.snapshot.staff.push(staff);
    this.persist();
    return staff;
  }

  async saveSchedule(schedule: WorkSchedule): Promise<WorkSchedule> {
    this.requireOrganization();
    if (
      !this.snapshot.staff.some((item) => item.id === schedule.staffId) ||
      !this.snapshot.locations.some((item) => item.id === schedule.locationId) ||
      schedule.weekdays.length === 0 ||
      schedule.startsAt >= schedule.endsAt
    ) {
      throw new UiFailure(
        "INVALID_DEMO_INPUT",
        "Выберите мастера, филиал и корректные часы работы.",
      );
    }
    this.snapshot.schedules = this.snapshot.schedules.filter(
      (item) =>
        !(
          item.staffId === schedule.staffId &&
          item.locationId === schedule.locationId
        ),
    );
    this.snapshot.schedules.push({
      ...schedule,
      weekdays: [...schedule.weekdays],
    });
    this.persist();
    return schedule;
  }

  async getSlotSuggestions(
    staffId: string,
    locationId: string,
    date: string,
  ): Promise<SlotView[]> {
    const schedule = this.snapshot.schedules.find(
      (item) => item.staffId === staffId && item.locationId === locationId,
    );
    if (!schedule || !schedule.weekdays.includes(parseDay(date).getDay()))
      return [];
    // Fixed fixture suggestions, with no real capacity/booking calculations.
    return DEMO_SUGGESTIONS.filter(
      (time) => time >= schedule.startsAt && time < schedule.endsAt,
    ).map((time) => ({ time, label: `${time} · демо-слот` }));
  }

  async createBooking(draft: CreateBookingDraft): Promise<BookingView> {
    const org = this.requireOrganization();
    if (
      !this.snapshot.services.some((item) => item.id === draft.serviceId) ||
      !this.snapshot.staff.some((item) => item.id === draft.staffId) ||
      !this.snapshot.locations.some((item) => item.id === draft.locationId) ||
      !draft.clientAlias.trim()
    ) {
      throw new UiFailure(
        "INVALID_DEMO_INPUT",
        "Заполните обязательные поля демонстрационной записи.",
      );
    }
    // A deliberately scripted collision to demonstrate conflict UI, NOT scheduling policy.
    if (
      this.snapshot.bookings.some(
        (item) =>
          item.staffId === draft.staffId &&
          item.date === draft.date &&
          item.time === draft.time &&
          item.status === "demo-confirmed",
      )
    ) {
      throw new UiFailure(
        "SLOT_CONFLICT",
        "Демо-конфликт: время уже выбрано в этой сессии.",
      );
    }
    const booking: BookingView = {
      ...draft,
      clientAlias: draft.clientAlias.trim(),
      id: makeId(),
      organizationId: org.id,
      status: "demo-confirmed",
    };
    this.snapshot.bookings.push(booking);
    this.persist();
    return booking;
  }

  async resetDemo(): Promise<void> {
    this.snapshot = empty();
    this.storage?.removeItem(STORAGE_KEY);
  }
}
