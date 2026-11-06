import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDatabase } from "./pg.js";
import { IdentityStore } from "../src/service/identity/store.js";
import { WalletService, yuan, cost, parsePrice } from "../src/service/wallet/service.js";
import { wallets, walletRequests, walletSettings } from "../src/service/db/schema/index.js";
import { MessageMeter } from "../src/service/wallet/proxy.js";

const price = { input: 1_000_000, output: 2_000_000, cacheRead: 100_000, cacheWrite: 1_250_000 };
const model = { deploymentId: "model", versionId: "version", priceVersionId: "price-version", name: "Fixture", price };
const code = (name: string) => (e: any) => e.code === name;
test("wallet money/usage math and fragmented SSE require final usage", () => {
  assert.equal(yuan("0.000001"), 1);
  for (const n of [-1, "NaN", "0.0000001", 1e20]) assert.throws(() => yuan(n));
  assert.equal(cost(price, { input: 100, output: 10, cacheRead: 20, cacheWrite: 4 }), 127);
  assert.throws(() => parsePrice({ input: 1, output: 1 }));
  const meter = new MessageMeter();
  const frames = 'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0}}}\r\n\r\ndata: {"type":"message_delta","usage":{"output_tokens":10}}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n';
  for (const char of frames) meter.feed(char);
  assert.deepEqual(meter.result(), { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
  const incomplete = new MessageMeter(); incomplete.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: {"type":"message_stop"}\n\n');
  assert.equal(incomplete.result(), undefined);
});
test("signup grants, batch gifts and Plus calendar grants are idempotent", async () => {
  const d = await testDatabase(), identity = new IdentityStore(d.db), w = new WalletService(d.db);
  try {
    await Promise.all([identity.ensure("a"), identity.ensure("a")]);
    assert.equal((await w.summary("a")).balance, 10_000_000);
    await w.configure({ signupYuan: "3", plusYuan: "2" });
    await identity.ensure("b"); assert.equal((await w.summary("b")).balance, 3_000_000);
    await identity.ensure("a"); assert.equal((await w.summary("a")).balance, 10_000_000);
    const gift = { id: randomUUID(), amountYuan: "1.5", userIds: ["b", "a"], note: "batch" };
    await Promise.all([w.gift("admin", gift), w.gift("admin", gift)]);
    assert.equal((await w.summary("a")).balance, 11_500_000);
    assert.equal((await w.summary("b")).balance, 4_500_000);
    await assert.rejects(w.gift("admin", { ...gift, amountYuan: 2 }), code("GIFT_ID_CONFLICT"));
    await assert.rejects(w.gift("admin", { ...gift, id: randomUUID(), userIds: ["a", "missing"] }), code("GIFT_USER_UNAVAILABLE"));
    assert.equal((await w.summary("a")).balance, 11_500_000);
    await d.db.update(wallets).set({ plusSince: Date.parse("2026-01-31T15:59:00Z"), plusUntil: Date.parse("2026-03-01T00:00:00+08:00") }).where(eq(wallets.userId, "a"));
    await Promise.all([w.grantPlus("a", Date.parse("2026-03-02")), w.grantPlus("a", Date.parse("2026-03-02"))]);
    assert.equal((await w.summary("a")).balance, 15_500_000, "Jan and Feb once, no March after expiry");
    await w.setPlus("a", null);
    const balance = (await w.summary("a")).balance;
    await w.tick(); assert.equal((await w.summary("a")).balance, balance);
  } finally { await d.close(); }
});
test("reservations serialize cross-session requests; settlement preserves concurrent gifts and caps debt", async () => {
  const d = await testDatabase(), identity = new IdentityStore(d.db), w = new WalletService(d.db);
  try {
    await identity.ensure("a");
    const results = await Promise.allSettled([w.reserve("a", "one", model), w.reserve("a", "two", model)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.ok(results.some(r => r.status === "rejected" && code("WALLET_BUSY")(r.reason)));
    const first = results.find(r => r.status === "fulfilled")!;
    if (first.status !== "fulfilled") throw Error("fixture");
    await w.gift("admin", { id: randomUUID(), amountYuan: 2, userIds: ["a"], note: "during request" });
    await Promise.all([w.settle(first.value.id, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }), w.settle(first.value.id, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })]);
    assert.equal((await w.summary("a")).balance, 12_000_000 - 120);
    assert.equal((await w.summary("a")).reserved, 0);
    const next = await w.reserve("a", "one", model);
    await w.settle(next.id, { input: 100_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const summary = await w.summary("a");
    assert.equal(summary.available, 0); assert.ok(summary.requests.find(r => r.id === next.id)!.waived! > 0);
    await assert.rejects(w.reserve("a", "one", model), code("INSUFFICIENT_BALANCE"));
    await assert.rejects(w.reserve("a", "one", { ...model, price: null }), code("PRICE_REQUIRED"));
  } finally { await d.close(); }
});
test("uncertain requests survive restart; only explicit admin resolution releases the hold", async () => {
  const d = await testDatabase(), identity = new IdentityStore(d.db), w = new WalletService(d.db);
  try {
    await identity.ensure("a");
    const request = await w.reserve("a", "one", model); await w.recover();
    assert.equal((await w.summary("a")).requests[0].state, "unknown");
    await assert.rejects(w.reserve("a", "two", model), code("WALLET_BUSY"));
    await assert.rejects(w.settle(request.id, undefined, { amount: 20_000_000, note: "too high", actor: "admin" }), code("INVALID_AMOUNT"));
    await w.settle(request.id, undefined, { amount: 0, note: "confirmed no usage", actor: "admin" });
    await w.settle(request.id, undefined, { amount: 0, note: "confirmed no usage", actor: "admin" });
    assert.equal((await w.summary("a")).available, 10_000_000);
    await assert.rejects(w.settle(request.id, undefined, { amount: 1, note: "changed", actor: "admin" }), code("SETTLEMENT_CONFLICT"));
  } finally { await d.close(); }
});

test("interrupted requests release holds once without fabricating usage or refunding a completed request", async () => {
  const d = await testDatabase(), identity = new IdentityStore(d.db), w = new WalletService(d.db);
  try {
    await identity.ensure("a");
    const request = await w.reserve("a", "one", model);
    await w.unknown(request.id);
    await Promise.all([w.waiveInterrupted(request.id), w.waiveInterrupted(request.id)]);
    const summary = await w.summary("a");
    assert.equal(summary.reserved, 0);
    assert.equal(summary.balance, 10_000_000);
    assert.equal(summary.requests[0].actual, null);
    assert.equal(summary.requests[0].inputTokens, null);
    assert.equal(summary.requests[0].charged, 0);
    assert.equal(summary.ledger.filter(l => l.id === `request:${request.id}`).length, 1);
    const next = await w.reserve("a", "two", model);
    await w.settle(next.id, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    await w.waiveInterrupted(next.id);
    assert.equal((await w.summary("a")).spent, 120);
  } finally { await d.close(); }
});

test("estimated RMB holds allow parallel requests and settlement protects the other request's reservation", async () => {
  const d = await testDatabase(), identity = new IdentityStore(d.db), w = new WalletService(d.db);
  try {
    await identity.ensure("a");
    const results = await Promise.all([w.reserve("a", "one", model, 1_000_000), w.reserve("a", "two", model, 2_000_000)]);
    assert.equal((await w.summary("a")).reserved, 3_000_000);
    await w.settle(results[0].id, { input: 9_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const after = await w.summary("a");
    assert.equal(after.balance, 2_000_000);
    assert.equal(after.reserved, 2_000_000, "the other request's money remains protected");
    assert.equal(after.requests.find(r => r.id === results[0].id)!.charged, 8_000_000);
    await w.waiveInterrupted(results[1].id);
    assert.equal((await w.summary("a")).available, 2_000_000);
  } finally { await d.close(); }
});
