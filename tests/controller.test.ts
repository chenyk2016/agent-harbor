import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/runtime/controller.js";

test("uncertain engine state prevents a new writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-unknown-"));
  try {
    const controller = new Controller(root);
    let creates = 0;
    controller.backend.forSession = async () => {
      throw new Error("Engine unreachable");
    };
    controller.backend.create = async () => {
      creates++;
      return "never";
    };
    await assert.rejects(
      controller.run("one", "work", "fake"),
      /Engine unreachable/,
    );
    assert.equal(creates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("lost create response is reconciled by the name persisted before create", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-create-"));
  try {
    const controller = new Controller(root);
    let stopped = "";
    controller.backend.forSession = async () => [];
    controller.backend.imageId = async () => "sha256:test";
    controller.backend.create = async () => {
      throw new Error("Create response lost");
    };
    controller.backend.stop = async (id) => {
      stopped = id;
    };
    controller.backend.destroy = async () => {};
    const result = await controller.run("one", "work", "fake");
    assert.equal(result.status, "failed");
    assert.equal(stopped, result.containerId);
    assert.ok(stopped.startsWith("ah-"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata failure cannot prevent environment stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-finalizing-"));
  try {
    const controller = new Controller(root);
    let stopped = false;
    controller.backend.forSession = async () => [];
    controller.backend.imageId = async () => "sha256:test";
    controller.backend.create = async () => {
      throw new Error("start interrupted");
    };
    controller.backend.stop = async () => {
      stopped = true;
    };
    const save = controller.store.save.bind(controller.store);
    controller.store.save = async (session) => {
      if (session.status === "finalizing")
        throw new Error("metadata volume full");
      await save(session);
    };
    const result = await controller.run("one", "work", "fake");
    assert.equal(stopped, true);
    assert.equal(result.stopped, true);
    assert.equal(result.status, "reconciling");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new layout image cannot silently resume or overwrite an old-image session", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-layout-upgrade-"));
  try {
    const controller = new Controller(root);
    await controller.store.prepare("old");
    const previous = {
      sessionId: "old",
      generation: 2,
      sdkSessionId: "old-sdk-id",
      imageId: "sha256:old",
      stopped: true,
    };
    await controller.store.save(previous);
    let creates = 0;
    controller.backend.forSession = async () => [];
    controller.backend.imageId = async () => "sha256:new-layout";
    controller.backend.create = async () => {
      creates++;
      return "must-not-create";
    };
    await assert.rejects(
      controller.run("old", "continue", "fake"),
      /runtime image changed/,
    );
    assert.equal(creates, 0);
    assert.deepEqual(await controller.store.load("old"), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
