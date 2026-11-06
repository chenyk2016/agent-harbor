/** 文件状态回归：跨会话迟到响应、待确认上传编号和原对象归属。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { BrowserApi } from "../apps/web/src/state/api.js";
import { FileBrowser } from "../apps/web/src/state/files.js";
import type { FileListing, UploadedFile } from "../src/service/files/types.js";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const listing = (path: string): FileListing => ({ path, entries: [], truncated: false });
class FileApi extends BrowserApi {
  slowList?: ReturnType<typeof deferred<FileListing>>;
  slowUpload?: ReturnType<typeof deferred<UploadedFile>>;
  lost = false;
  ids: string[] = [];
  async files(_id: string, path: string) { if (this.slowList) { const gate = this.slowList; this.slowList = undefined; return gate.promise; } return listing(path); }
  async uploadFile(_id: string, id: string, file: File, sha256: string) {
    this.ids.push(id); if (this.lost) throw new TypeError("unknown response");
    return this.slowUpload ? this.slowUpload.promise : { name: file.name, size: file.size, sha256, path: `uploads/${id}/${file.name}` };
  }
}
function storage() { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } }; }
function browser(api: FileApi, saved = storage()) { return new FileBrowser(api, "user", saved, () => {}, () => {}, () => true, () => {}); }
async function wait(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await sleep(1); } throw new Error("state timeout"); }
test("A→B→A ignores the first directory result", async () => {
  const api = new FileApi(), files = browser(api), first = api.slowList = deferred();
  try {
    files.select("a"); files.show(true); files.select("b"); files.select("a");
    await wait(() => files.directory?.loading === false);
    first.resolve(listing("stale")); await sleep(1);
    assert.equal(files.directory!.path, ""); assert.equal(files.directory!.listing!.path, "");
  } finally { files.dispose(); }
});
test("upload completion belongs to its original session and never starts a message", async () => {
  const api = new FileApi(), files = browser(api); api.slowUpload = deferred();
  try {
    files.select("a"); const upload = files.upload([new File(["hello"], "资料.md")]);
    await wait(() => api.ids.length === 1); assert.equal(files.busy("a"), true);
    files.select("b"); assert.equal(files.currentJobs.length, 0);
    api.slowUpload.resolve({ name: "资料.md", size: 5, sha256: files.jobs[0].sha256, path: "uploads/original/资料.md" });
    await upload; assert.equal(files.currentJobs.length, 0);
    files.select("a"); assert.equal(files.currentJobs[0].status, "ready"); assert.equal(files.busy("a"), false);
  } finally { files.dispose(); }
});
test("unknown upload survives refresh; selecting the same bytes reuses its original ID", async () => {
  const api = new FileApi(), saved = storage(), files = browser(api, saved);
  files.select("a"); api.lost = true;
  await files.upload([new File(["hello"], "资料.md")]);
  const id = api.ids[0]; assert.equal(files.currentJobs[0].status, "unknown"); files.dispose();
  const restored = browser(api, saved);
  try {
    restored.select("a"); assert.equal(restored.currentJobs[0].id, id);
    api.lost = false; await restored.upload([new File(["hello"], "资料.md")]);
    assert.deepEqual(api.ids, [id, id]); assert.equal(restored.currentJobs[0].status, "ready");
    assert.equal(new FileBrowser(api, "other-user", saved, () => {}, () => {}, () => true, () => {}).jobs.length, 0);
  } finally { restored.dispose(); }
});


test("an old session upload error stays with its original card and does not toast in the new session", async () => {
  const api = new FileApi(), notifications: string[] = [];
  const files = new FileBrowser(api, "user", storage(), () => {}, text => notifications.push(text), () => true, () => {});
  api.slowUpload = deferred();
  try {
    files.select("a"); const uploading = files.upload([new File(["hello"], "old.md")]);
    await wait(() => api.ids.length === 1); files.select("b");
    api.slowUpload.reject(new TypeError("lost old response")); await uploading;
    assert.equal(files.currentJobs.length, 0); assert.deepEqual(notifications, []);
    files.select("a"); assert.equal(files.currentJobs[0].status, "unknown"); assert.ok(files.currentJobs[0].error);
  } finally { files.dispose(); }
});
