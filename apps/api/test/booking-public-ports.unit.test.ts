import assert from "node:assert/strict";
import test from "node:test";

import {
  createBookingInternal,
  CreateBookingFailure,
  cancelBookingInternal,
  CancelBookingFailure,
  rescheduleBookingInternal,
  RescheduleBookingFailure,
} from "../../../packages/domain-booking/src/index.js";
import * as create from "../../../packages/domain-booking/src/create.js";
import * as cancel from "../../../packages/domain-booking/src/cancel.js";
import * as reschedule from "../../../packages/domain-booking/src/reschedule.js";

test("trusted Booking ports preserve command and failure class identity", () => {
  assert.equal(createBookingInternal, create.createBookingInternal);
  assert.equal(CreateBookingFailure, create.CreateBookingFailure);
  assert.equal(cancelBookingInternal, cancel.cancelBookingInternal);
  assert.equal(CancelBookingFailure, cancel.CancelBookingFailure);
  assert.equal(rescheduleBookingInternal, reschedule.rescheduleBookingInternal);
  assert.equal(RescheduleBookingFailure, reschedule.RescheduleBookingFailure);
});
