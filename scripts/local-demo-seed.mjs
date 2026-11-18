// The disposable demo is populated via the real, verified owner HTTP clients.
// No SQL writes, private server calls, provider credentials or copied DTOs here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authenticateTelegramOwner, revokeTelegramOwnerSession } from "../apps/web/src/lib/owner-auth.ts";
import { createRealService, readRealServices } from "../apps/web/src/lib/services-api.ts";
import { createRealStaff, readRealStaff } from "../apps/web/src/lib/staff-api.ts";
import { publishStagingStaff } from "../apps/web/src/lib/staging-publication-api.ts";
import { createShiftPlan } from "../apps/web/src/lib/shift-plans-api.ts";
import { publishStagingShift, readPublishedShifts } from "../apps/web/src/lib/staging-shift-publication-api.ts";
import { localDemoFetch } from "./local-staging-mode.mjs";

export async function seedDemoCatalog(origin, signedProof, workspace) {
  const fetcher = localDemoFetch(origin);
  const session = await authenticateTelegramOwner(signedProof, fetcher);
  try {
    assert.equal(session.tenantId, workspace.tenantId);
    assert.deepEqual(await readRealServices(session, fetcher), []);
    const serviceDraft = {
      displayName: "Демо-стрижка", durationMinutes: 60, basePriceKopecks: 180000,
    };
    const service = await createRealService(session, serviceDraft, randomUUID(), fetcher);
    const staff = await createRealStaff(session, {
      displayName: "Демо-мастер", positionTitle: "Стилист",
      locationId: workspace.locationId, serviceId: service.id,
    }, randomUUID(), fetcher);
    await publishStagingStaff(session, {
      staffId: staff.id, locationId: workspace.locationId, serviceId: service.id,
      expectedServiceRevision: service.revision,
    }, randomUUID(), fetcher);
    // Explicit synthetic sample, not a default salon working-hours policy.
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const plan = await createShiftPlan(session, {
      staffId: staff.id, locationId: workspace.locationId,
      startLocal: date + "T10:00", endLocal: date + "T18:00",
    }, randomUUID(), fetcher);
    const published = await publishStagingShift(session, plan, randomUUID(), fetcher);
    const catalog = await readRealServices(session, fetcher);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, service.id);
    assert.equal(catalog[0].active, true);
    assert.equal(catalog[0].displayName, serviceDraft.displayName);
    assert.equal(catalog[0].durationMinutes, serviceDraft.durationMinutes);
    assert.equal(catalog[0].basePriceKopecks, serviceDraft.basePriceKopecks);
    const directory = await readRealStaff(session, fetcher);
    assert.equal(directory.staff.length, 1);
    assert.equal(directory.staff[0].id, staff.id);
    assert.equal(directory.staff[0].bookable, true);
    const shifts = await readPublishedShifts(session, fetcher);
    assert.deepEqual(shifts.published, [published]);
    return { date, serviceId: service.id, staffId: staff.id, locationId: workspace.locationId,
      price: String(serviceDraft.basePriceKopecks), name: serviceDraft.displayName };
  } finally {
    // Even the short-lived seed session is revoked before interactive login.
    await revokeTelegramOwnerSession(session, fetcher);
  }
}
