import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, lockSession } from "../src/runtime/storage.js";

test("store persists session identity and SDK ID, without accepting a path as ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-store-"));
  try {
    const store = new Store(root);
    await store.prepare("one");
    await store.save({
      sessionId: "one",
      generation: 2,
      sdkSessionId: "sdk-one",
      stopped: true,
    });
    assert.equal((await store.load("one")).sdkSessionId, "sdk-one");
    assert.throws(() => store.directory("../other"));
    await store.save({ sessionId: "one", generation: 3 });
    assert.equal(
      JSON.parse(await readFile(join(root, "one/session.json"), "utf8"))
        .generation,
      3,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("OS lock excludes a second writer and can be acquired after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-lock-"));
  try {
    const release = await lockSession(root);
    await assert.rejects(lockSession(root), /already running/);
    await release();
    await (
      await lockSession(root)
    )();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt metadata is not treated as a new empty session", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-corrupt-"));
  try {
    const store = new Store(root);
    const directory = await store.prepare("one");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, "session.json"), "{");
    await assert.rejects(store.load("one"), SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
