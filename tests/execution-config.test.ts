import test from "node:test";
import assert from "node:assert/strict";
import { profileFromEnvironment } from "../src/service/config.js";

test("execution limits default to unlimited and accept explicit positive caps", () => {
  const keys = ["AH_TASK_TIMEOUT_MS", "AH_MAX_TURNS", "AH_MAX_BUDGET_USD"];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    let profile = profileFromEnvironment();
    assert.deepEqual([profile.timeoutMs, profile.maxTurns, profile.maxBudgetUsd], [0, 0, 0]);
    process.env.AH_TASK_TIMEOUT_MS = "300000";
    process.env.AH_MAX_TURNS = "30";
    process.env.AH_MAX_BUDGET_USD = "0.5";
    profile = profileFromEnvironment();
    assert.deepEqual([profile.timeoutMs, profile.maxTurns, profile.maxBudgetUsd], [300000, 30, 0.5]);
    process.env.AH_TASK_TIMEOUT_MS = "-1";
    assert.throws(profileFromEnvironment, /AH_TASK_TIMEOUT_MS/);
    process.env.AH_TASK_TIMEOUT_MS = "0";
    process.env.AH_MAX_BUDGET_USD = "NaN";
    assert.throws(profileFromEnvironment, /AH_MAX_BUDGET_USD/);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
});
