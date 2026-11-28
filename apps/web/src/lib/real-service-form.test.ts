import assert from "node:assert/strict";
import test from "node:test";

import {
  ServiceApiFailure,
  serviceSaveIsUncertain,
  type ServiceFailureReason,
} from "./services-api";

import {
  emptyRealServiceForm,
  realServiceDraftFromForm,
} from "./real-service-form";

test("new and reset real service forms have no implicit business values", () => {
  const first = emptyRealServiceForm();
  assert.equal(first.serviceDuration, undefined);
  assert.equal(first.servicePrice, undefined);
  assert.equal(first.serviceBuffer, undefined);
  first.serviceName = "Synthetic service";
  assert.equal(realServiceDraftFromForm(first), null);
  first.serviceDuration = 45;
  assert.equal(realServiceDraftFromForm(first), null);
  first.servicePrice = 1200;
  assert.equal(realServiceDraftFromForm(first), null);
  first.serviceBuffer = 0;
  assert.ok(realServiceDraftFromForm(first));
  assert.deepEqual(emptyRealServiceForm(), {
    serviceName: "",
    serviceDuration: undefined,
    servicePrice: undefined,
    serviceBuffer: undefined,
  });
});

test("explicit free price and selected duration are valid", () => {
  assert.deepEqual(
    realServiceDraftFromForm({
      serviceName: " Synthetic service ",
      serviceDuration: 45,
      servicePrice: 0,
      serviceBuffer: 0,
    }),
    {
      displayName: "Synthetic service",
      durationMinutes: 45,
      basePriceKopecks: 0,
      postServiceBufferMinutes: 0,
    },
  );
});

test("missing, cleared or invalid numeric inputs are never sent as a draft", () => {
  const valid = {
    serviceName: "Synthetic service",
    serviceDuration: 45,
    servicePrice: 1200.5,
    serviceBuffer: 15,
  };
  assert.equal(realServiceDraftFromForm(valid)?.basePriceKopecks, 120050);
  for (const serviceDuration of [undefined, NaN, 0, 1.5, 1441]) {
    assert.equal(realServiceDraftFromForm({ ...valid, serviceDuration }), null);
  }
  for (const servicePrice of [undefined, NaN, Infinity, -1, 0.001]) {
    assert.equal(realServiceDraftFromForm({ ...valid, servicePrice }), null);
  }
  assert.equal(realServiceDraftFromForm(valid)?.postServiceBufferMinutes, 15);
  for (const serviceBuffer of [undefined, NaN, Infinity, -1, 0.5, 1441]) {
    assert.equal(realServiceDraftFromForm({ ...valid, serviceBuffer }), null);
  }
});

test("service write uncertainty survives later definitive rejections", () => {
  const definitive: ServiceFailureReason[] = [
    "unauthorized",
    "conflict",
    "capacity",
    "stale-revision",
    "draft-unavailable",
  ];
  for (const reason of definitive) {
    const error = new ServiceApiFailure(reason);
    assert.equal(serviceSaveIsUncertain(false, error), false);
    assert.equal(serviceSaveIsUncertain(true, error), true);
  }
  for (const error of [
    new ServiceApiFailure("unavailable"),
    new ServiceApiFailure("invalid-response"),
    new Error("network"),
  ]) {
    assert.equal(serviceSaveIsUncertain(false, error), true);
    assert.equal(serviceSaveIsUncertain(true, error), true);
  }
});
