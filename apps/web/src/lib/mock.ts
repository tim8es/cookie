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
import { localDay, parseDay } from "./dates";

export interface DemoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = "cookie.frontend-demo.v1";
const DEMO_SUGGESTIONS = ["10:00", "12:00", "15:00"];

function empty(): DemoSnapshot {
  return {
    organization: null,
    locations: [],
    services: [],
    staff: [],
    schedules: [],
    bookings: [],
  };
}

function makeId(): string {
  const nativeId = globalThis.crypto?.randomUUID?.();
  if (nativeId) return nativeId;
  return `demo-${Math.random().toString(36).slice(2)}`;
}

function storageFromBrowser(): DemoStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function invalid(message: string): UiFailure {
  return new UiFailure("INVALID_DEMO_INPUT", message);
}

function hasId(items: { id: string }[], id: string): boolean {
  return items.some((item) => item.id === id);
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
      if (cached) {
        this.snapshot = JSON.parse(cached) as DemoSnapshot;
      } else {
        this.snapshot = empty();
      }
    } catch {
      this.snapshot = empty();
    }
  }

  private persist(): void {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.snapshot));
  }

  private requireOrganization(): Organization {
    if (!this.snapshot.organization) {
      const message = "Сначала создайте тестовую организацию.";
      throw new UiFailure("NOT_FOUND", message);
    }
    return this.snapshot.organization;
  }

  async getSnapshot(): Promise<DemoSnapshot> {
    return structuredClone(this.snapshot);
  }

  async createOrganization(name: string): Promise<Organization> {
    if (!name.trim()) {
      throw invalid("Введите название тестового салона.");
    }
    if (this.snapshot.organization) {
      throw invalid("Демо-организация уже существует.");
    }
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
    if (!name.trim()) {
      throw invalid("Укажите название филиала.");
    }
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
    const positiveDuration = durationMinutes > 0;
    const validDuration = positiveDuration && Number.isFinite(durationMinutes);
    const validPrice = Number.isFinite(basePriceRub) && basePriceRub >= 0;
    if (!name.trim() || !validDuration || !validPrice) {
      throw invalid("Проверьте название, длительность и базовую цену.");
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
    const knownServices = this.snapshot.services.map((service) => service.id);
    const isUnknown = (id: string): boolean => !knownServices.includes(id);
    const hasInvalidService = serviceIds.some(isUnknown);
    if (!displayName.trim() || serviceIds.length === 0 || hasInvalidService) {
      throw invalid("Укажите имя и хотя бы одну существующую услугу.");
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
    const existsStaff = hasId(this.snapshot.staff, schedule.staffId);
    const existsLocation = hasId(this.snapshot.locations, schedule.locationId);
    const validHours = schedule.startsAt < schedule.endsAt;
    if (
      !existsStaff ||
      !existsLocation ||
      schedule.weekdays.length === 0 ||
      !validHours
    ) {
      throw invalid("Выберите мастера, филиал и корректные часы работы.");
    }
    this.snapshot.schedules = this.snapshot.schedules.filter((item) => {
      const sameStaff = item.staffId === schedule.staffId;
      const sameLocation = item.locationId === schedule.locationId;
      return !(sameStaff && sameLocation);
    });
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
    const schedule = this.snapshot.schedules.find((item) => {
      return item.staffId === staffId && item.locationId === locationId;
    });
    if (!schedule) return [];
    const activeWeekday = schedule.weekdays.includes(parseDay(date).getDay());
    if (!activeWeekday) return [];
    // Fixed fixture suggestions, with no real capacity/booking calculations.
    const withinHours = (time: string): boolean => {
      return time >= schedule.startsAt && time < schedule.endsAt;
    };
    const slots = DEMO_SUGGESTIONS.filter(withinHours);
    return slots.map((time) => ({ time, label: `${time} · демо-слот` }));
  }

  async createBooking(draft: CreateBookingDraft): Promise<BookingView> {
    const org = this.requireOrganization();
    const existsService = hasId(this.snapshot.services, draft.serviceId);
    const existsStaff = hasId(this.snapshot.staff, draft.staffId);
    const existsLocation = hasId(this.snapshot.locations, draft.locationId);
    if (
      !existsService ||
      !existsStaff ||
      !existsLocation ||
      !draft.clientAlias.trim()
    ) {
      throw invalid("Заполните обязательные поля демонстрационной записи.");
    }
    // A scripted collision illustrates conflict UI, NOT scheduling policy.
    const collision = this.snapshot.bookings.some((item) => {
      return (
        item.staffId === draft.staffId &&
        item.date === draft.date &&
        item.time === draft.time &&
        item.status === "demo-confirmed"
      );
    });
    if (collision) {
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

  async cancelBooking(id: string): Promise<BookingView> {
    this.requireOrganization();
    const booking = this.snapshot.bookings.find((item) => item.id === id);
    if (!booking) throw new UiFailure("NOT_FOUND", "Демо-запись не найдена.");
    if (booking.status !== "demo-cancelled") {
      booking.status = "demo-cancelled";
      this.persist();
    }
    return structuredClone(booking);
  }

  async rescheduleBooking(
    id: string,
    date: string,
    time: string,
  ): Promise<BookingView> {
    this.requireOrganization();
    const booking = this.snapshot.bookings.find((item) => item.id === id);
    if (!booking) throw new UiFailure("NOT_FOUND", "Демо-запись не найдена.");
    if (booking.status !== "demo-confirmed") {
      throw invalid("Отменённую демо-запись нельзя перенести.");
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      localDay(parseDay(date)) !== date
    ) {
      throw invalid("Укажите корректную дату для переноса.");
    }
    const choices = await this.getSlotSuggestions(
      booking.staffId,
      booking.locationId,
      date,
    );
    if (!choices.some((item) => item.time === time)) {
      throw invalid(
        "Выберите время из настроенных демонстрационных интервалов.",
      );
    }
    const occupied = this.snapshot.bookings.some(
      (item) =>
        item.id !== id &&
        item.status === "demo-confirmed" &&
        item.staffId === booking.staffId &&
        item.date === date &&
        item.time === time,
    );
    if (occupied) {
      throw new UiFailure(
        "SLOT_CONFLICT",
        "Демо-конфликт: время уже занято другой записью в этой вкладке.",
      );
    }
    booking.date = date;
    booking.time = time;
    this.persist();
    return structuredClone(booking);
  }

  async resetDemo(): Promise<void> {
    this.snapshot = empty();
    this.storage?.removeItem(STORAGE_KEY);
  }
}
