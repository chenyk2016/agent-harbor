/** 真实HTTP、磁盘与Python目录边界；不启动Docker或调用模型。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, readdir, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Controller } from "../src/runtime/controller.js";
import { Auth, tokenHash } from "../src/service/auth.js";
import { createApi } from "../src/service/http-api.js";
import { SessionManager } from "../src/service/session-manager.js";
import { ServiceStore } from "../src/service/service-store.js";
import { WorkspaceFiles } from "../src/service/files/workspace-files.js";
import { testDatabase } from "./pg.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harbor-files-"));
  const database = await testDatabase();
  const store = new ServiceStore(database.db);
  const controller = new Controller(root);
  const manager = new SessionManager(store, { open: async () => { throw new Error("Unexpected execution"); } }, "unused");
  const files = new WorkspaceFiles(root);
  assert.equal(await files.initialize(), true);
  const auth = new Auth([{ userId: "a", tokenHash: tokenHash("test-a") }, { userId: "b", tokenHash: tokenHash("test-b") }]);
  await manager.identity.adoptSessionOwners();
  await manager.identity.importKeys(auth.keys);
  const server = createApi(manager, controller, files);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const one = await manager.create("a", "one"), two = await manager.create("b", "two");
  await controller.store.prepare(one.id); await controller.store.prepare(two.id);
  const workspace = join(root, one.id, "workspace");
  const api = (suffix: string, init: RequestInit = {}) => fetch(`${base}/api/sessions/${one.id}/files${suffix}`, { ...init, headers: { Authorization: "Bearer test-a", ...init.headers } });
  const upload = (id: string, name: string, text: string) => api(`/uploads/${id}?name=${encodeURIComponent(name)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Content-Sha256": hash(text) }, body: text });
  return { root, workspace, manager, store, database, files, api, upload, one, two, base, async clean() {
    manager.stopping = true; await files.close(); await manager.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await database.close(); await rm(root, { recursive: true, force: true });
  } };
}
async function wait(check: () => Promise<boolean>) { for (let n = 0; n < 150; n++) { if (await check()) return; await sleep(10); } throw new Error("timeout"); }

test("closed environment accepts multiline/Chinese uploads, original IDs deduplicate, names do not overwrite", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), text = "第一行\n  第二行\n";
    assert.equal((await f.upload(id, "需求 说明.md", text)).status, 201);
    assert.equal((await f.upload(id, "需求 说明.md", text)).status, 200);
    assert.equal((await f.upload(id, "需求 说明.md", "changed")).status, 409);
    assert.equal((await f.upload(id, "other.md", text)).status, 409);
    assert.equal((await f.upload(randomUUID(), "需求 说明.md", "second")).status, 201);
    const path = `uploads/${id}/需求 说明.md`;
    assert.equal(await readFile(join(f.workspace, path), "utf8"), text);
    const status = await (await f.api(`/uploads/${id}?name=${encodeURIComponent("需求 说明.md")}`)).json() as { sha256: string };
    assert.equal(status.sha256, hash(text));
    const preview = await (await f.api(`/preview?path=${encodeURIComponent(path)}`)).json() as { text: string };
    assert.equal(preview.text, text);
    const download = await f.api(`/download?path=${encodeURIComponent(path)}`);
    assert.equal(await download.text(), text);
    assert.match(download.headers.get("content-disposition")!, /attachment;.*UTF-8''/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await f.store.session(f.one.id))!.environment, "closed");
    assert.equal((await f.store.messages(f.one.id)).length, 0);
    await wait(async () => (await readdir(join(f.root, ".service/file-transfers"))).length === 0);
  } finally { await f.clean(); }
});

test("file APIs enforce session ownership and reject traversal, parent/leaf links, hardlinks and FIFO", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "secret"), "private sentinel");
    await mkdir(join(f.workspace, "normal"));
    await symlink(f.root, join(f.workspace, "outside"));
    await symlink(join(f.root, "secret"), join(f.workspace, "leaf"));
    await link(join(f.root, "secret"), join(f.workspace, "hard"));
    execFileSync("mkfifo", [join(f.workspace, "fifo")]);
    for (const path of ["../secret", "/etc/passwd", "outside/secret", "leaf", "hard", "fifo", "normal/../../secret", "normal\\secret"]) {
      const response = await f.api(`/preview?path=${encodeURIComponent(path)}`);
      assert.ok([400, 403].includes(response.status), `${path}: ${response.status}`);
      assert.doesNotMatch(await response.text(), /private sentinel/);
    }
    const listing = await (await f.api("")).json() as { entries: { name: string; kind: string }[] };
    assert.ok(listing.entries.filter(e => ["outside", "leaf", "hard", "fifo"].includes(e.name)).every(e => e.kind === "blocked"));
    for (const suffix of ["", "/preview?path=secret", "/download?path=secret", `/uploads/${randomUUID()}?name=a`]) {
      const response = await fetch(`${f.base}/api/sessions/${f.two.id}/files${suffix}`, { headers: { Authorization: "Bearer test-a" } });
      assert.equal(response.status, 404);
    }
    assert.equal((await f.upload(randomUUID(), "../escape", "x")).status, 400);
    assert.equal((await f.upload(randomUUID(), "line\nbreak", "x")).status, 400);
    assert.equal((await f.api("/preview?path=.service/access-keys.json")).status, 404);
  } finally { await f.clean(); }
});

test("preview is bounded and inert; binary, oversized transfer and checksum failure keep the workspace clean", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "page.html"), '<script>alert("x")</script>');
    const html = await (await f.api("/preview?path=page.html")).json() as { text: string };
    assert.match(html.text, /<script>/);
    await writeFile(join(f.workspace, "large.txt"), "好".repeat(100000));
    const large = await (await f.api("/preview?path=large.txt")).json() as { text: string; truncated: boolean };
    assert.equal(large.truncated, true); assert.ok(Buffer.byteLength(large.text) <= 256 * 1024); assert.doesNotMatch(large.text, /�/);
    await writeFile(join(f.workspace, "binary.dat"), Buffer.from([0, 255, 1]));
    assert.equal((await f.api("/preview?path=binary.dat")).status, 415);
    const id = randomUUID();
    assert.equal((await f.api(`/uploads/${id}?name=a`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Content-Sha256": hash("different") }, body: "bad hash" })).status, 422);
    await assert.rejects(stat(join(f.workspace, "uploads", id)));
    const oversized = await f.api(`/uploads/${randomUUID()}?name=a`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Content-Sha256": hash("x") }, body: Buffer.alloc(20 * 1024 * 1024 + 1) });
    assert.equal(oversized.status, 413);
    await wait(async () => (await readdir(join(f.root, ".service/file-transfers"))).length === 0);
  } finally { await f.clean(); }
});

test("incomplete upload is private and excludes new tasks; disconnect releases its slot and cleans staging", async () => {
  const f = await fixture();
  const id = randomUUID();
  const req = httpRequest(`${f.base}/api/sessions/${f.one.id}/files/uploads/${id}?name=a.txt`, { method: "PUT", headers: { Authorization: "Bearer test-a", "Content-Type": "application/octet-stream", "Content-Length": "2", "X-Content-Sha256": hash("ab") } });
  req.on("error", () => {});
  try {
    req.write("a");
    await wait(async () => (await readdir(join(f.root, ".service/file-transfers"))).length === 1);
    await assert.rejects(f.manager.submit("a", f.one.id, randomUUID(), "must wait"), /FILE_TRANSFER_BUSY/);
    await assert.rejects(stat(join(f.workspace, "uploads", id)));
    req.destroy();
    await wait(async () => (await readdir(join(f.root, ".service/file-transfers"))).length === 0);
    assert.equal((await f.upload(randomUUID(), "after.txt", "after abort")).status, 201);
    await f.store.accept(f.one.id, randomUUID(), "active task");
    assert.equal((await f.upload(randomUUID(), "busy.txt", "x")).status, 409);
  } finally { req.destroy(); await f.clean(); }
});

test("a parent repeatedly replaced by an external link never exposes the private file", async () => {
  const f = await fixture();
  let stopped = false;
  try {
    const outside = join(f.root, "private"); await mkdir(outside); await writeFile(join(outside, "value"), "secret outside workspace");
    const dir = join(f.workspace, "switch"), parked = join(f.workspace, "parked");
    await mkdir(dir); await writeFile(join(dir, "value"), "inside workspace");
    const changing = (async () => {
      while (!stopped) {
        await rename(dir, parked); await symlink(outside, dir); await sleep(1); await rm(dir); await rename(parked, dir); await sleep(1);
      }
    })();
    try {
      for (let n = 0; n < 35; n++) {
        const response = await f.api("/preview?path=switch/value");
        const text = await response.text(); assert.doesNotMatch(text, /secret outside workspace/);
        assert.ok([200, 403, 404].includes(response.status));
        if (response.ok) assert.equal((JSON.parse(text) as { text: string }).text, "inside workspace");
      }
    } finally { stopped = true; await changing; }
  } finally { await f.clean(); }
});

test("service shutdown aborts a stalled upload instead of waiting for the client to send more bytes", async () => {
  const f = await fixture();
  const req = httpRequest(`${f.base}/api/sessions/${f.one.id}/files/uploads/${randomUUID()}?name=a.txt`, { method: "PUT", headers: { Authorization: "Bearer test-a", "Content-Type": "application/octet-stream", "Content-Length": "2", "X-Content-Sha256": hash("ab") } });
  req.on("error", () => {});
  try {
    req.write("a");
    await wait(async () => (await readdir(join(f.root, ".service/file-transfers"))).length === 1);
    await Promise.race([f.files.close(), sleep(1500).then(() => { throw new Error("shutdown blocked on upload"); })]);
    assert.deepEqual(await readdir(join(f.root, ".service/file-transfers")), []);
  } finally { req.destroy(); await f.clean(); }
});

test("chunked uploads enforce the streamed byte limit; oversized downloads fail before producing a response body", async () => {
  const f = await fixture();
  try {
    const result = await new Promise<number>((done, reject) => {
      const req = httpRequest(`${f.base}/api/sessions/${f.one.id}/files/uploads/${randomUUID()}?name=large.txt`, { method: "PUT", headers: { Authorization: "Bearer test-a", "Content-Type": "application/octet-stream", "Transfer-Encoding": "chunked", "X-Content-Sha256": hash("unused") } }, response => {
        response.resume(); response.on("end", () => done(response.statusCode!));
      });
      req.on("error", reject); req.end(Buffer.alloc(20 * 1024 * 1024 + 1));
    });
    assert.equal(result, 413);
    const { open } = await import("node:fs/promises");
    const sparse = await open(join(f.workspace, "large.bin"), "w");
    try { await sparse.truncate(100 * 1024 * 1024 + 1); } finally { await sparse.close(); }
    const download = await f.api("/download?path=large.bin");
    assert.equal(download.status, 413); assert.doesNotMatch(download.headers.get("content-type")!, /octet-stream/);
    await wait(async () => (await readdir(join(f.root, ".service/file-transfers"))).length === 0);
  } finally { await f.clean(); }
});
