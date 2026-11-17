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

test("appearance preview is validated, local-only, and survives existing demo storage", async () => {
  const storage = new MemoryStorage();
  const api = new MockCookieApi(storage);
  await api.createOrganization("Тестовая студия");
  const saved = await api.saveAppearance({
    theme: "forest",
    introduction: "  У нас ждут гостей  ",
  });
  assert.deepEqual(saved, {
    theme: "forest",
    introduction: "У нас ждут гостей",
  });
  const restored = await new MockCookieApi(storage).getSnapshot();
  assert.deepEqual(restored.appearance, saved);
  await assert.rejects(
    () =>
      api.saveAppearance({ theme: "unknown" as "forest", introduction: "x" }),
    (error: unknown) =>
      error instanceof UiFailure && error.code === "INVALID_DEMO_INPUT",
  );
  await assert.rejects(
    () => api.saveAppearance({ theme: "clay", introduction: "x".repeat(121) }),
    (error: unknown) =>
      error instanceof UiFailure && error.code === "INVALID_DEMO_INPUT",
  );
  assert.deepEqual((await api.getSnapshot()).appearance, saved);
  await api.resetDemo();
  assert.equal((await api.getSnapshot()).appearance.theme, "atelier");
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

test("local cancellation preserves history, releases fixture collision and survives reload", async () => {
  const storage = new MemoryStorage();
  const api = new MockCookieApi(storage);
  await api.createOrganization("Демо");
  const locationId = (await api.getSnapshot()).locations[0]?.id;
  if (!locationId) throw new Error("Missing synthetic branch");
  const serviceId = (await api.addService("Стрижка", 60, 500)).id;
  const staffId = (await api.addStaff("Мастер", "Стилист", [serviceId])).id;
  const draft = {
    staffId,
    serviceId,
    locationId,
    date: "2026-11-16",
    time: "10:00",
    clientAlias: "Демо",
  };
  const first = await api.createBooking(draft);
  const cancelled = await api.cancelBooking(first.id);
  assert.equal(cancelled.status, "demo-cancelled");
  assert.equal(cancelled.id, first.id);
  assert.equal((await api.cancelBooking(first.id)).status, "demo-cancelled");
  const replacement = await api.createBooking(draft);
  assert.notEqual(replacement.id, first.id);
  const restored = await new MockCookieApi(storage).getSnapshot();
  assert.deepEqual(
    restored.bookings.map((booking) => booking.status),
    ["demo-cancelled", "demo-confirmed"],
  );
  await assert.rejects(
    () => api.cancelBooking("missing"),
    (error: unknown) =>
      error instanceof UiFailure && error.code === "NOT_FOUND",
  );
});

test("local reschedule uses only fixture slots and rejects same-master collisions", async () => {
  const storage = new MemoryStorage();
  const api = new MockCookieApi(storage);
  await api.createOrganization("Демо");
  const locationId = (await api.getSnapshot()).locations[0]?.id;
  if (!locationId) throw new Error("Missing synthetic branch");
  const serviceId = (await api.addService("Услуга", 30, 0)).id;
  const staffId = (await api.addStaff("Мастер", "Стилист", [serviceId])).id;
  await api.saveSchedule({
    staffId,
    locationId,
    weekdays: [1],
    startsAt: "09:00",
    endsAt: "18:00",
  });
  const base = {
    staffId,
    locationId,
    serviceId,
    date: "2026-11-16",
    clientAlias: "Гость",
  };
  const moved = await api.createBooking({ ...base, time: "10:00" });
  const other = await api.createBooking({ ...base, time: "12:00" });
  const conflict = (error: unknown): boolean =>
    error instanceof UiFailure && error.code === "SLOT_CONFLICT";
  const invalid = (error: unknown): boolean =>
    error instanceof UiFailure && error.code === "INVALID_DEMO_INPUT";
  await assert.rejects(
    () => api.rescheduleBooking(moved.id, base.date, "12:00"),
    conflict,
  );
  await assert.rejects(
    () => api.rescheduleBooking(moved.id, "2026-11-17", "15:00"),
    invalid,
  );
  await assert.rejects(
    () => api.rescheduleBooking(moved.id, "2026-02-30", "10:00"),
    invalid,
  );
  await assert.rejects(
    () => api.rescheduleBooking(moved.id, base.date, "19:00"),
    invalid,
  );
  const updated = await api.rescheduleBooking(moved.id, "2026-11-23", "15:00");
  assert.equal(updated.id, moved.id);
  assert.equal(updated.date, "2026-11-23");
  assert.equal(updated.time, "15:00");
  const stored = (await new MockCookieApi(storage).getSnapshot()).bookings;
  assert.equal(stored.find((b) => b.id === moved.id)?.date, updated.date);
  assert.equal(stored.find((b) => b.id === other.id)?.time, "12:00");
  await api.cancelBooking(moved.id);
  await assert.rejects(
    () => api.rescheduleBooking(moved.id, base.date, "10:00"),
    invalid,
  );
});
