import test from "node:test";
import assert from "node:assert/strict";
import { messagePeriod, parseLimits } from "../src/service/limits/policy.js";

test("message limits allow unlimited or nonnegative integers; month is Shanghai", () => {
  assert.equal(parseLimits({}).monthlyMessages, null);
  assert.equal(parseLimits({ monthlyMessages: 0 }).monthlyMessages, 0);
  assert.equal(parseLimits({ monthlyMessages: 100 }).monthlyMessages, 100);
  for (const monthlyMessages of [-1, 0.5, "100", NaN]) assert.throws(() => parseLimits({ monthlyMessages }));
  assert.equal(messagePeriod(Date.parse("2026-10-31T15:59:59Z")), "2026-10");
  assert.equal(messagePeriod(Date.parse("2026-10-31T16:00:00Z")), "2026-11");
});
