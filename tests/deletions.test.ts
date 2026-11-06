import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testDatabase } from "./pg.js";
import { Controller } from "../src/runtime/controller.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { createApi } from "../src/service/http-api.js";
import { tokenHash } from "../src/service/auth.js";
import { ServiceClient } from "../src/clients/service-client.js";
import { WalletService } from "../src/service/wallet/service.js";
import { ResourceDeletions } from "../src/service/deletions/service.js";
async function fixture() {
  const database = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-delete-")),
    controller = new Controller(root);
  let stop: (() => void) | undefined,
    terminated = 0;
  const manager = new SessionManager(
    new ServiceStore(database.db),
    {
      open: async (id) => ({
        run: async () => {
          await new Promise<void>((resolve) => {
            stop = resolve;
          });
          return {
            sessionId: id,
            generation: 1,
            status: "cancelled" as const,
            environment: "closed" as const,
          };
        },
        terminate: async () => {
          terminated++;
          stop?.();
        },
        close: async () => {
          stop?.();
        },
      }),
    },
    "fixture-only",
  );
  await manager.identity.importKeys(
    ["a", "b"].map((id) => ({
      userId: id,
      tokenHash: tokenHash("fixture-" + id),
    })),
  );
  const server = createApi(manager, controller);
  manager.deletions!.resident.findOwned = async () => [];
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    a = new ServiceClient(origin, "fixture-a"),
    b = new ServiceClient(origin, "fixture-b");
  const create = async () => {
    const s = await manager.create("a", "Direct delete");
    await mkdir(join(root, s.id, "workspace"), { recursive: true });
    await writeFile(
      join(root, s.id, "workspace", "result.txt"),
      "private result",
    );
    return s;
  };
  const done = async (id: string) => {
    for (let i = 0; i < 150; i++) {
      const j = await manager.deletions!.job("a", id);
      if (j.state !== "running") return j;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("Deletion timed out");
  };
  return {
    database,
    root,
    manager,
    controller,
    a,
    b,
    create,
    done,
    terminated: () => terminated,
    started: () => !!stop,
    async close() {
      await manager.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("direct session deletion removes content and files, preserves finance, rejects other users and is idempotent", async () => {
  const f = await fixture(),
    outside = await mkdtemp(join(tmpdir(), "ah-delete-outside-"));
  try {
    const s = await f.create(),
      peer = await f.create();
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(f.root, s.id, "workspace", "outside"));
    const m = await f.manager.store.accept(s.id, randomUUID(), "secret prompt");
    await f.manager.store.transition(m.message.id, "succeeded");
    const wallet = new WalletService(f.database.db);
    await wallet.gift("a", {
      id: randomUUID(),
      amountYuan: "5",
      note: "fixture",
      userIds: ["a"],
    });
    const before = await wallet.summary("a");
    await assert.rejects(
      f.b.request("/sessions/" + s.id, "DELETE"),
      (e: any) => e.status === 404,
    );
    const jobs = await Promise.all([
      f.a.request<any>("/sessions/" + s.id, "DELETE"),
      f.a.request<any>("/sessions/" + s.id, "DELETE"),
    ]);
    assert.equal(jobs[0].id, jobs[1].id);
    assert.equal((await f.done(jobs[0].id)).state, "completed");
    await assert.rejects(lstat(join(f.root, s.id)), { code: "ENOENT" });
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
    for (const path of [
      "/sessions/" + s.id,
      "/sessions/" + s.id + "/history",
      "/sessions/" + s.id + "/files/download?path=result.txt",
    ])
      await assert.rejects(f.a.request(path), (e: any) => e.status === 404);
    const counts = await f.database.pool.query(
      'SELECT (SELECT count(*) FROM messages WHERE "sessionId"=$1) AS messages,(SELECT count(*) FROM events WHERE "sessionId"=$1) AS events',
      [s.id],
    );
    assert.equal(counts.rows[0].messages, "0");
    assert.equal(counts.rows[0].events, "0");
    assert.deepEqual(await wallet.summary("a"), before);
    assert(await f.manager.store.session(peer.id));
    assert.equal(
      (await f.a.request<any>("/sessions/" + s.id, "DELETE")).state,
      "completed",
    );
    await assert.rejects(
      f.b.request("/deletions/" + jobs[0].id),
      (e: any) => e.status === 404,
    );
  } finally {
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});
test("deleting an active task confirms termination before removing its workspace and blocks new messages", async () => {
  const f = await fixture();
  try {
    const s = await f.create();
    await f.manager.submit("a", s.id, randomUUID(), "wait");
    for (let i = 0; i < 50 && !f.started(); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert(f.started());
    const j = await f.a.request<any>("/sessions/" + s.id, "DELETE");
    await assert.rejects(
      f.manager.submit("a", s.id, randomUUID(), "must not run"),
      (e: any) => ["RESOURCE_DELETING", "SESSION_NOT_FOUND"].includes(e.code),
    );
    assert.equal((await f.done(j.id)).state, "completed");
    assert(f.terminated() > 0);
    await assert.rejects(lstat(join(f.root, s.id)), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});
test("unknown engine cleanup retains a non-restorable checkpoint; retry and process-restart recovery finish idempotently", async () => {
  const f = await fixture();
  try {
    const s = await f.create();
    const previous = await f.manager.store.accept(
      s.id,
      randomUUID(),
      "private prior message",
    );
    await f.manager.store.transition(previous.message.id, "succeeded");
    f.manager.deletions!.resident.findOwned = async () => {
      throw Error("engine unavailable");
    };
    const job = await f.a.request<any>("/sessions/" + s.id, "DELETE");
    assert.equal((await f.done(job.id)).state, "failed");
    assert(await lstat(join(f.root, s.id)));
    const listed = await f.a.request<any[]>("/sessions");
    assert.equal(
      listed.find((item) => item.id === s.id).deletionState,
      "failed",
    );
    assert.equal(listed.find((item) => item.id === s.id).message, null);
    const page = await f.a.request<any[]>(
      "/sessions?order=created&after=" + s.id,
    );
    assert(Array.isArray(page));
    await assert.rejects(
      f.manager.owned("a", s.id),
      (e: any) => e.code === "RESOURCE_DELETING",
    );
    f.manager.deletions!.resident.findOwned = async () => [];
    const retried = await f.a.request<any>("/sessions/" + s.id, "DELETE");
    assert.equal(retried.id, job.id);
    assert.equal((await f.done(job.id)).state, "completed");
    const next = await f.create();
    await f.database.db.execute(
      sql`INSERT INTO resource_deletions(id,"ownerId",kind,"resourceId","sessionId",state,phase,"createdAt","updatedAt") VALUES(${randomUUID()},'a','session',${next.id},${next.id},'running','deleting_files',0,0)`,
    );
    const resumed = new ResourceDeletions(
      f.manager,
      f.root,
      (f.manager.deletions as any).files,
    );
    resumed.resident.findOwned = async () => [];
    await resumed.resume();
    const pending = (await resumed.list("a")).find(
      (x) => x.resourceId === next.id,
    )!;
    assert.equal((await f.done(pending.id)).state, "completed");
    await assert.rejects(lstat(join(f.root, next.id)), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("credential revocation failure still stops owned containers and retains files until a confirmed retry", async () => {
  const f = await fixture();
  try {
    const s = await f.create();
    let present = true,
      stopped = false;
    f.manager.onEnvironmentClose = async () => {
      throw Error("fixture gateway unavailable");
    };
    f.manager.deletions!.resident.findOwned = async () =>
      present ? [{ backendId: "docker", resourceId: "owned-fixture-container" }] : [];
    f.manager.deletions!.resident.stopAndConfirm = async () => {
      stopped = true;
    };
    f.manager.deletions!.resident.remove = async () => {
      present = false;
    };
    const job = await f.a.request<any>("/sessions/" + s.id, "DELETE");
    assert.equal((await f.done(job.id)).state, "failed");
    assert(stopped);
    assert(await lstat(join(f.root, s.id)));
    f.manager.onEnvironmentClose = undefined;
    await f.a.request("/sessions/" + s.id, "DELETE");
    assert.equal((await f.done(job.id)).state, "completed");
    await assert.rejects(lstat(join(f.root, s.id)), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});
