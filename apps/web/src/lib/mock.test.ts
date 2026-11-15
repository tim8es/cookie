import assert from "node:assert/strict";
import { test } from "node:test";
import { MockCookieApi, type DemoStorage } from "./mock";
import { UiFailure } from "./model";

class MemoryStorage implements DemoStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("onboarding fixture: org → service → staff → schedule → booking visible in calendar snapshot", async () => {
  const storage = new MemoryStorage();
  const api = new MockCookieApi(storage);
  const org = await api.createOrganization("Тестовая студия");
  const location = (await api.getSnapshot()).locations[0];
  if (!location) throw new Error("Synthetic location was not created");
  const service = await api.addService("Стрижка", 45, 1200);
  const staff = await api.addStaff("Мастер Демо", "Стилист", [service.id]);
  const date = "2026-11-16";

  await api.saveSchedule({
    staffId: staff.id,
    locationId: location.id,
    weekdays: [1],
    startsAt: "09:00",
    endsAt: "18:00",
  });

  const slots = await api.getSlotSuggestions(staff.id, location.id, date);
  assert.ok(slots.some((slot) => slot.time === "10:00"));

  const booking = await api.createBooking({
    staffId: staff.id,
    locationId: location.id,
    serviceId: service.id,
    date,
    time: "10:00",
    clientAlias: "Тестовый клиент",
  });

  assert.equal(booking.status, "demo-confirmed");
  const refreshed = await api.getSnapshot();
  assert.equal(refreshed.bookings[0]?.id, booking.id);
  const restored = await new MockCookieApi(storage).getSnapshot();
  assert.equal(restored.organization?.id, org.id);
});

test("mock shows an explicit conflict instead of silently duplicating a fixture slot", async () => {
  const api = new MockCookieApi(new MemoryStorage());
  await api.createOrganization("Тест");
  const locationId = (await api.getSnapshot()).locations[0]?.id;
  if (!locationId) throw new Error("Synthetic location was not created");
  const serviceId = (await api.addService("Услуга", 30, 0)).id;
  const staffId = (await api.addStaff("Мастер", "Мастер", [serviceId])).id;
  const draft = {
    locationId,
    serviceId,
    staffId,
    date: "2026-11-16",
    time: "10:00",
    clientAlias: "Гость",
  };

  await api.createBooking(draft);
  const isConflict = (error: unknown): boolean =>
    error instanceof UiFailure && error.code === "SLOT_CONFLICT";
  await assert.rejects(() => api.createBooking(draft), isConflict);
});

test("mock provides empty suggestions without a configured schedule and supports reset", async () => {
  const api = new MockCookieApi(new MemoryStorage());
  const slots = await api.getSlotSuggestions("a", "b", "2026-11-16");
  assert.deepEqual(slots, []);
  await api.createOrganization("Студия");
  await api.resetDemo();
  const snapshot = await api.getSnapshot();
  assert.equal(snapshot.organization, null);
});
