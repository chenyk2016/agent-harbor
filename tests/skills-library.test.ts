/** 个人技能的完整HTTP/PG链路；构建器夹具只替代Docker工作，不替代文件、权限或事务。 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, cp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { eq } from "drizzle-orm";
import { testDatabase } from "./pg.js";
import type { SessionDetail } from "../src/clients/service-client.js";
import { ExpertService } from "../src/service/experts/service.js";
import { SkillService } from "../src/service/skills/service.js";
import { SkillBuildManager } from "../src/service/skills/build-manager.js";
import { SkillBuilder } from "../src/docker/skill-builder.js";
import { PackageStore } from "../src/service/skills/package-store.js";
import { ServiceStore } from "../src/service/service-store.js";
import { SessionManager } from "../src/service/session-manager.js";
import { Controller } from "../src/runtime/controller.js";
import { createApi } from "../src/service/http-api.js";
import { ServiceClient, ApiError } from "../src/clients/service-client.js";
import { tokenHash } from "../src/service/auth.js";
import {
  expertInstalls,
  skillBuildRequests,
  skillBuilds,
  userSkills,
  skills,
} from "../src/service/db/schema/index.js";

const md = (slug = "table-summary", body = "Summarize the input.") =>
  `---\nname: ${slug}\ndescription: Summarize a table\n---\n\n${body}\n`;
const source = (text = md()) => [
  { path: "SKILL.md", content: Buffer.from(text) },
];
const code = (expected: string) => (error: unknown) =>
  error instanceof Error && error.message.includes(expected);
async function wait(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
}
async function zip(files: { path: string; content: Buffer }[]) {
  const archive = new yazl.ZipFile(),
    chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  for (const file of files) archive.addBuffer(file.content, file.path);
  archive.end();
  return output;
}
async function fixture(hold = false) {
  const database = await testDatabase(),
    root = await mkdtemp(join(tmpdir(), "ah-skills-")),
    library = new SkillService(database.db, root);
  const driver = new SkillBuilder(root);
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((resolve) => {
      started = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  driver.imageId = async () => "sha256:fixture";
  driver.materials = async (_files, _manifest, path) => {
    await mkdir(path, { recursive: true });
    return { files: 0, bytes: 0 };
  };
  driver.build = async (input, signal) => {
    started();
    if (hold)
      await Promise.race([
        gate,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
    if (signal.aborted) throw new Error("cancelled");
    await cp(input.source, input.output, { recursive: true });
    return driver.artifactHash(input.output);
  };
  driver.stop = async () => {};
  const builds = new SkillBuildManager(library, driver),
    store = new ServiceStore(database.db),
    controller = new Controller(root);
  const manager = new SessionManager(store, controller, "fixture");
  await manager.identity.importKeys(
    ["a", "b"].map((userId) => ({
      userId,
      tokenHash: tokenHash(`key-${userId}`),
    })),
  );
  const server = createApi(
    manager,
    controller,
    undefined,
    {},
    { library, builds },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const a = new ServiceClient(url, "key-a"),
    b = new ServiceClient(url, "key-b");
  return {
    database,
    root,
    library,
    builds,
    driver,
    store,
    controller,
    a,
    b,
    url,
    release,
    began,
    async close() {
      release();
      await builds.close();
      await manager.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("source library preserves binaries, owner boundaries, immutable versions and revision/idempotency", async () => {
  const f = await fixture();
  try {
    const key = randomUUID(),
      files = [
        ...source(),
        { path: "assets/template.bin", content: Buffer.from([0xff, 0, 3, 4]) },
      ];
    const skill = await f.library.create("a", key, "Table", files);
    assert.equal(
      (await f.library.create("a", key, "Table", files)).id,
      skill.id,
    );
    await assert.rejects(
      f.library.create("a", key, "Changed", files),
      code("REQUEST_ID_CONFLICT"),
    );
    await assert.rejects(
      f.library.detail("b", skill.id),
      code("SKILL_NOT_FOUND"),
    );
    await assert.rejects(
      f.library.save("a", skill.id, randomUUID(), randomUUID(), []),
      code("VERSION_CONFLICT"),
    );
    const published = (await f.library.version("a", skill.currentVersionId!))
      .version;
    const next = await f.library.save(
      "a",
      skill.id,
      skill.currentVersionId!,
      randomUUID(),
      [{ path: "SKILL.md", text: md("table-summary", "New instructions") }],
    );
    const second = (await f.library.version("a", next.currentVersionId!))
      .version;
    assert.notEqual(second.sourceHash, published.sourceHash);
    assert.match(
      (await f.library.packages.files(published.sourcePath))
        .find((file) => file.path === "SKILL.md")!
        .content.toString(),
      /Summarize the input/,
    );
    const exported = await f.library.packages.unzip(
      await f.library.packages.export(published.sourcePath),
    );
    assert.deepEqual(
      exported.files.find((file) => file.path.endsWith(".bin"))!.content,
      files[1].content,
    );
    await f.library.remove("a", skill.id);
    assert.equal((await f.library.list("a")).length, 0);
    assert.equal(
      (await f.library.version("a", published.id)).version.id,
      published.id,
    );
  } finally {
    await f.close();
  }
});

test("ZIP import checks content hash, reports compatibility and applies only once", async () => {
  const f = await fixture();
  try {
    const content = await zip(source()),
      hash = createHash("sha256").update(content).digest("hex"),
      key = randomUUID();
    const record = await f.library.newImport(
      "a",
      key,
      "table.zip",
      content.length,
      hash,
    );
    assert.equal(
      (await f.library.newImport("a", key, "table.zip", content.length, hash))
        .id,
      record.id,
    );
    await assert.rejects(
      f.library.upload("a", record.id, Buffer.from("wrong")),
      code("IMPORT_CONTENT_MISMATCH"),
    );
    const checked = await f.library.upload("a", record.id, content);
    assert.equal((checked.report as { ok: boolean }).ok, true);
    const skill = await f.library.applyImport("a", record.id);
    assert.equal((await f.library.applyImport("a", record.id)).id, skill.id);
    const uploaded = await fetch(
      `${f.url}/api/skill-imports/${record.id}/content`,
      {
        method: "PUT",
        headers: { Authorization: "Bearer key-b" },
        body: new Uint8Array(content).buffer,
      },
    );
    assert.equal(uploaded.status, 404);
  } finally {
    await f.close();
  }
});

test("wrapped roots preserve all skill resources and binary changes affect source digest", async () => {
  const store = new PackageStore("unused");
  const files = [
    { path: "wrapped/SKILL.md", content: Buffer.from(md()) },
    { path: "wrapped/.claude-plugin/plugin.json", content: Buffer.from("{}") },
  ];
  assert.equal((await store.unzip(await zip(files))).report.ok, true);
  const a = store.check([
    ...source(),
    { path: "a.bin", content: Buffer.from([255, 1]) },
  ]);
  const b = store.check([
    ...source(),
    { path: "a.bin", content: Buffer.from([255, 2]) },
  ]);
  assert.notEqual(a.report.digest, b.report.digest);
});

test("shared preparation survives one cancellation; last cancellation does not publish a ready artifact", async () => {
  const f = await fixture(true);
  try {
    const skill = await f.library.create("a", randomUUID(), "Table", source()),
      version = (await f.library.version("a", skill.currentVersionId!)).version;
    const one = await f.builds.request("a", version.id, randomUUID());
    await f.began;
    const two = await f.builds.request("a", version.id, randomUUID());
    assert.equal(one.request.buildId, two.request.buildId);
    await f.builds.cancel("a", one.request.id);
    assert.equal(
      (await f.builds.detail("a", two.request.id)).request.state,
      "waiting",
    );
    await f.builds.cancel("a", two.request.id);
    await wait(
      async () =>
        (await f.builds.detail("a", two.request.id)).build.state ===
        "cancelled",
    );
    await f.builds.retry("a", two.request.id, 1);
    f.release();
    await wait(
      async () =>
        (await f.builds.detail("a", two.request.id)).build.state === "ready",
    );
    assert.equal(
      (await f.builds.detail("a", one.request.id)).request.state,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("late preparation cannot reactivate a disabled skill; the selected session remains fixed", async () => {
  const f = await fixture(true);
  try {
    const skill = await f.library.create("a", randomUUID(), "Table", source()),
      version = (await f.library.version("a", skill.currentVersionId!)).version;
    const intent = await f.builds.setDefault(
      "a",
      skill.id,
      true,
      version.id,
      0,
      randomUUID(),
    );
    await f.began;
    await f.builds.setDefault(
      "a",
      skill.id,
      false,
      undefined,
      intent.setting!.revision,
      randomUUID(),
    );
    f.release();
    await wait(
      async () =>
        (await f.builds.detail("a", intent.setting!.pendingRequestId!)).build
          .state === "ready",
    );
    assert.equal((await f.library.detail("a", skill.id)).setting!.enabled, 0);
    const snapshot = await f.builds.selection("a", [version.id]);
    const sessionRequest = {
      title: "Fixed",
      clientRequestId: randomUUID(),
      skillSelection: {
        skillVersionIds: [version.id],
        expectedSelectionDigest: snapshot.digest,
      },
    };
    const session = await f.a.request<{
      id: string;
      capabilitySnapshot: typeof snapshot;
    }>("/sessions", "POST", sessionRequest);
    assert.equal(session.capabilitySnapshot.digest, snapshot.digest);
    assert.equal(
      (await f.a.request<{ id: string }>("/sessions", "POST", sessionRequest))
        .id,
      session.id,
    );
    const next = await f.library.save(
      "a",
      skill.id,
      skill.currentVersionId!,
      randomUUID(),
      [{ path: "SKILL.md", text: md("table-summary", "Different version") }],
    );
    assert.notEqual(next.currentVersionId, skill.currentVersionId);
    assert.equal(
      (await f.store.session(session.id))!.capabilitySnapshot!.skills[0]
        .versionId,
      version.id,
    );
    await assert.rejects(
      f.b.request(`/sessions/${session.id}`),
      (error) => error instanceof ApiError && error.status === 404,
    );
  } finally {
    await f.close();
  }
});

test("builtin releases are immutable, read-only and copied into an independent personal version", async () => {
  const f = await fixture();
  try {
    const one = await f.library.installBuiltin("Table", source());
    assert.deepEqual(await f.library.installBuiltin("Table", source()), one);
    await assert.rejects(
      f.library.save("a", one.skillId, one.versionId, randomUUID(), []),
      code("SKILL_NOT_FOUND"),
    );
    const copy = await f.library.copyVersion(
      "a",
      one.versionId,
      randomUUID(),
      "My table",
    );
    assert.equal(copy.source, "private");
    assert.equal(copy.ownerId, "a");
    const next = await f.library.installBuiltin(
      "Table",
      source(md("table-summary", "Updated builtin")),
    );
    assert.equal(next.skillId, one.skillId);
    assert.notEqual(next.versionId, one.versionId);
    assert.match(
      (
        await f.a.request<{ text: string }[]>(
          `/skill-versions/${copy.currentVersionId}/files`,
        )
      )[0].text,
      /Summarize the input/,
    );
    assert.equal(
      (await f.library.version("b", one.versionId)).version.versionNumber,
      1,
    );
  } finally {
    await f.close();
  }
});

test("concurrent session retries return one fixed session; binary preview remains binary", async () => {
  const f = await fixture();
  try {
    const skill = await f.library.create("a", randomUUID(), "Table", [
      ...source(),
      { path: "data.bin", content: Buffer.from([255, 254, 0]) },
    ]);
    const version = (await f.library.version("a", skill.currentVersionId!))
      .version;
    const files = await f.a.request<{ path: string; text?: string }[]>(
      `/skill-versions/${version.id}/files`,
    );
    assert.equal(
      files.find((file) => file.path === "data.bin")!.text,
      undefined,
    );
    const request = {
      clientRequestId: randomUUID(),
      title: "One session",
      skillSelection: { skillVersionIds: [] },
    };
    const results = await Promise.all([
      f.a.request<{ id: string }>("/sessions", "POST", request),
      f.a.request<{ id: string }>("/sessions", "POST", request),
    ]);
    assert.equal(results[0].id, results[1].id);
    assert.equal((await f.store.sessions("a")).length, 1);
    await assert.rejects(
      f.a.request("/sessions", "POST", { ...request, title: "Changed" }),
      code("REQUEST_ID_CONFLICT"),
    );
  } finally {
    await f.close();
  }
});

test("unconfirmed preparation stop retains occupancy and blocks retry until restart reconciliation", async () => {
  const f = await fixture(true);
  try {
    const skill = await f.library.create("a", randomUUID(), "Table", source()),
      version = (await f.library.version("a", skill.currentVersionId!)).version;
    const request = await f.builds.request("a", version.id, randomUUID());
    await f.began;
    f.driver.stop = async () => {
      throw new Error("engine unavailable");
    };
    await f.builds.cancel("a", request.request.id);
    await wait(
      async () =>
        (await f.builds.detail("a", request.request.id)).build.state ===
        "reconciling",
    );
    await assert.rejects(
      f.builds.retry("a", request.request.id, 1),
      code("BUILD_ATTEMPT_CONFLICT"),
    );
    await assert.rejects(
      f.builds.request("a", version.id, randomUUID()),
      code("BUILD_STOPPING"),
    );
    await assert.rejects(f.builds.close(), /cleanup unconfirmed/);
    f.driver.stop = async () => {};
    const restarted = new SkillBuildManager(f.library, f.driver);
    await restarted.initialize();
    assert.equal(
      (await restarted.detail("a", request.request.id)).build.state,
      "failed",
    );
    await restarted.close();
  } finally {
    // The original manager deliberately retains the uncertain task; the restarted manager reconciled it.
    f.builds.close = async () => {};
    await f.close();
  }
});

test("save creates one version for all edits, retries deduplicate and stale editors cannot overwrite", async () => {
  const f = await fixture();
  try {
    const skill = await f.library.create("a", randomUUID(), "Table", source());
    assert.equal(skill.versions.length, 1);
    assert.equal(skill.versions[0].versionNumber, 1);
    assert.deepEqual(
      await readdir(join(f.root, f.library.packages.skillPath("a", skill.id))),
      ["versions"],
    );
    const request = {
      expectedVersionId: skill.currentVersionId,
      clientRequestId: randomUUID(),
      changes: [
        { path: "SKILL.md", text: md("table-summary", "Updated") },
        { path: "scripts/demo.py", text: "print('hi')" },
      ],
    };
    const next = await f.a.request<typeof skill>(
      `/skills/${skill.id}/versions`,
      "POST",
      request,
    );
    assert.equal(next.versions.length, 2);
    assert.equal(next.versions[0].versionNumber, 2);
    assert.equal(
      (
        await f.a.request<typeof skill>(
          `/skills/${skill.id}/versions`,
          "POST",
          request,
        )
      ).versions.length,
      2,
    );
    await assert.rejects(
      f.a.request(`/skills/${skill.id}/versions`, "POST", {
        ...request,
        changes: [],
      }),
      code("REQUEST_ID_CONFLICT"),
    );
    await assert.rejects(
      f.a.request(`/skills/${skill.id}/versions`, "POST", {
        ...request,
        clientRequestId: randomUUID(),
      }),
      code("VERSION_CONFLICT"),
    );
    await assert.rejects(
      f.b.request(`/skills/${skill.id}/versions`, "POST", request),
      code("SKILL_NOT_FOUND"),
    );
    await assert.rejects(
      f.a.request(`/skills/${skill.id}/draft`),
      (error) => error instanceof ApiError && error.status === 404,
    );
    await assert.rejects(
      f.a.request(`/skills/${skill.id}/publish`, "POST", {}),
      (error) => error instanceof ApiError && error.status === 404,
    );
    assert.match(
      (
        await f.a.request<{ text?: string }[]>(
          `/skill-versions/${skill.currentVersionId}/files`,
        )
      )[0].text!,
      /Summarize the input/,
    );
  } finally {
    await f.close();
  }
});

test("import replacement creates a version atomically and retries do not add versions", async () => {
  const f = await fixture();
  try {
    const skill = await f.library.create("a", randomUUID(), "Table", source());
    const content = await zip(source(md("table-summary", "Imported version")));
    const row = await f.library.newImport(
      "a",
      randomUUID(),
      "table.zip",
      content.length,
      createHash("sha256").update(content).digest("hex"),
    );
    await f.library.upload("a", row.id, content);
    await assert.rejects(
      f.library.applyImport("a", row.id, skill.id, randomUUID()),
      code("VERSION_CONFLICT"),
    );
    const next = await f.library.applyImport(
      "a",
      row.id,
      skill.id,
      skill.currentVersionId!,
    );
    assert.equal(next.versions.length, 2);
    assert.equal(
      (
        await f.library.applyImport(
          "a",
          row.id,
          skill.id,
          skill.currentVersionId!,
        )
      ).currentVersionId,
      next.currentVersionId,
    );
    await assert.rejects(
      f.library.applyImport("a", row.id),
      code("IMPORT_ALREADY_APPLIED"),
    );
  } finally {
    await f.close();
  }
});

test("legacy draft migration preserves unpublished work, skips identical content and is repeatable", async () => {
  const f = await fixture();
  try {
    const skill = await f.library.create("a", randomUUID(), "Table", source());
    const path = `${f.library.packages.skillPath("a", skill.id)}/drafts/legacy`;
    await f.library.packages.publish(
      path,
      source(md("table-summary", "Unpublished work")),
    );
    await f.database.db
      .update(skills)
      .set({ draftPath: path })
      .where(eq(skills.id, skill.id));
    assert.deepEqual(await f.library.migrateDrafts(), {
      scanned: 1,
      promoted: 1,
    });
    const next = await f.library.detail("a", skill.id);
    assert.equal(next.versions.length, 2);
    assert.match(
      (
        await f.a.request<{ text: string }[]>(
          `/skill-versions/${next.currentVersionId}/files`,
        )
      )[0].text,
      /Unpublished work/,
    );
    await f.database.db
      .update(skills)
      .set({ draftPath: path })
      .where(eq(skills.id, skill.id));
    assert.deepEqual(await f.library.migrateDrafts(), {
      scanned: 1,
      promoted: 0,
    });
    assert.deepEqual(await f.library.migrateDrafts(), {
      scanned: 0,
      promoted: 0,
    });
    // 从未发布过的旧技能也会直接拥有 v1。
    await f.database.db
      .delete(userSkills)
      .where(eq(userSkills.skillId, skill.id));
    const legacyId = randomUUID(),
      legacyPath = `${f.library.packages.skillPath("a", legacyId)}/drafts/legacy`;
    await f.library.packages.publish(legacyPath, source(md("legacy")));
    await f.database.db.insert(skills).values({
      id: legacyId,
      ownerId: "a",
      source: "private",
      slug: "legacy",
      displayName: "Legacy",
      draftPath: legacyPath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    assert.deepEqual(await f.library.migrateDrafts(), {
      scanned: 1,
      promoted: 1,
    });
    assert.equal(
      (await f.library.detail("a", legacyId)).versions[0].versionNumber,
      1,
    );
  } finally {
    await f.close();
  }
});

const expertDefinition = (
  skillVersionIds: string[] = [],
  role = "Review the supplied material.",
) => ({
  name: "Reviewer",
  description: "Review documents",
  role,
  workflow: "Read, check, explain.",
  output: "Write a concise report.",
  examples: ["Review this document"],
  skillVersionIds,
});

test("experts save immutable versions, enforce ownership, copy builtin and reject stale/reused saves", async () => {
  const f = await fixture();
  try {
    const service = new ExpertService(f.library, f.builds),
      requestId = randomUUID(),
      input = expertDefinition();
    const one = await service.save("a", requestId, input);
    assert.equal(one.versions[0].versionNumber, 1);
    assert.equal((await service.save("a", requestId, input)).id, one.id);
    await assert.rejects(
      service.save("a", requestId, { ...input, name: "Changed" }),
      code("REQUEST_ID_CONFLICT"),
    );
    await assert.rejects(service.detail("b", one.id), code("EXPERT_NOT_FOUND"));
    const key = randomUUID(),
      updated = expertDefinition([], "Different role");
    const two = await service.save(
      "a",
      key,
      updated,
      one.id,
      one.currentVersionId,
    );
    assert.equal(two.versions.length, 2);
    assert.equal(two.versions[1].definition.role, input.role);
    assert.equal(
      (await service.save("a", key, updated, one.id, one.currentVersionId))
        .versions.length,
      2,
    );
    await assert.rejects(
      service.save("a", randomUUID(), input, one.id, one.currentVersionId),
      code("EXPERT_VERSION_CONFLICT"),
    );
    const built = await service.installBuiltin(expertDefinition());
    assert.equal(
      (await service.installBuiltin(expertDefinition())).versionId,
      built.versionId,
    );
    await assert.rejects(
      service.save("a", randomUUID(), input, built.id, built.versionId),
      code("EXPERT_NOT_FOUND"),
    );
    const copy = await service.copy("a", built.versionId, randomUUID());
    assert.equal(copy.source, "private");
    const privateSkill = await f.library.create(
      "a",
      randomUUID(),
      "Table",
      source(),
    );
    await assert.rejects(
      service.installBuiltin(
        expertDefinition([privateSkill.currentVersionId!]),
      ),
      code("SKILL_NOT_FOUND"),
    );
    await service.remove("a", one.id);
    assert.ok(!(await service.list("a")).some((item) => item.id === one.id));
    await assert.rejects(
      service.install("a", two.currentVersionId),
      code("EXPERT_DISABLED"),
    );
  } finally {
    await f.close();
  }
});

test("expert multi-skill registration rolls back the whole batch when the queue fills", async () => {
  const f = await fixture(true);
  try {
    const service = new ExpertService(f.library, f.builds);
    const a = await f.library.create(
        "a",
        randomUUID(),
        "A",
        source(md("first")),
      ),
      b = await f.library.create("a", randomUUID(), "B", source(md("second")));
    for (let i = 0; i < 19; i++)
      await f.builds.request("a", a.currentVersionId!, randomUUID());
    const expert = await service.save(
      "a",
      randomUUID(),
      expertDefinition([a.currentVersionId!, b.currentVersionId!]),
    );
    await assert.rejects(
      service.install("a", expert.currentVersionId),
      code("BUILD_QUEUE_LIMIT"),
    );
    assert.equal((await f.database.db.select().from(expertInstalls)).length, 0);
    assert.equal(
      (await f.database.db.select().from(skillBuildRequests)).length,
      19,
    );
    assert.equal((await f.database.db.select().from(skillBuilds)).length, 1);
  } finally {
    await f.close();
  }
});

test("expert install deduplicates, shares preparation and cancels only its own waiters", async () => {
  const f = await fixture(true);
  try {
    const service = new ExpertService(f.library, f.builds),
      skill = await f.library.create("a", randomUUID(), "Table", source());
    const personal = await f.builds.request(
      "a",
      skill.currentVersionId!,
      randomUUID(),
    );
    await f.began;
    const expert = await service.save(
      "a",
      randomUUID(),
      expertDefinition([skill.currentVersionId!]),
    );
    const [one, two] = await Promise.all([
      service.install("a", expert.currentVersionId),
      service.install("a", expert.currentVersionId),
    ]);
    assert.equal(one.id, two.id);
    assert.equal(one.items[0].request.buildId, personal.request.buildId);
    await assert.rejects(
      service.installation("b", one.id),
      code("EXPERT_INSTALL_NOT_FOUND"),
    );
    await service.cancel("a", one.id);
    assert.equal(
      (await f.builds.detail("a", personal.request.id)).request.state,
      "waiting",
    );
    f.release();
    await wait(
      async () =>
        (await f.builds.detail("a", personal.request.id)).build.state ===
        "ready",
    );
    const again = await service.install("a", expert.currentVersionId);
    assert.notEqual(again.id, one.id);
    assert.equal(again.state, "ready");
    assert.equal((await f.database.db.select().from(userSkills)).length, 0);
    assert.equal(
      (await service.resolve("a", expert.currentVersionId)).capabilities
        .skills[0].versionId,
      skill.currentVersionId,
    );
    await f.library.remove("a", skill.id);
    await assert.rejects(
      service.resolve("a", expert.currentVersionId),
      code("SKILL_DISABLED"),
    );
  } finally {
    await f.close();
  }
});

test("failed expert waiter can rejoin another expert's successful retry without rebuilding", async () => {
  const f = await fixture(true);
  try {
    const service = new ExpertService(f.library, f.builds),
      skill = await f.library.create("a", randomUUID(), "Table", source());
    const original = f.driver.build.bind(f.driver);
    let failOnce = true;
    f.driver.build = async (input, signal, log) => {
      const hash = await original(input, signal, log);
      if (failOnce) {
        failOnce = false;
        throw new Error("fixture install failed");
      }
      return hash;
    };
    const first = await service.save(
      "a",
      randomUUID(),
      expertDefinition([skill.currentVersionId!]),
    );
    const second = await service.save("a", randomUUID(), {
      ...expertDefinition([skill.currentVersionId!]),
      name: "Other",
    });
    const a = await service.install("a", first.currentVersionId),
      b = await service.install("a", second.currentVersionId);
    f.release();
    await wait(
      async () => (await service.installation("a", a.id)).state === "failed",
    );
    await service.retry("a", a.id, a.items[0].request.id, 1);
    await wait(
      async () => (await service.installation("a", a.id)).state === "ready",
    );
    const before = await service.installation("a", b.id);
    assert.equal(before.items[0].build.attempt, 2);
    assert.equal(before.state, "failed");
    const done = await service.retry("a", b.id, b.items[0].request.id, 2);
    assert.equal(done.state, "ready");
    assert.equal(done.items[0].build.attempt, 2);
    await assert.rejects(
      service.retry("a", a.id, a.items[0].request.id, 1),
      code("BUILD_ATTEMPT_CONFLICT"),
    );
  } finally {
    await f.close();
  }
});

test("expert session snapshots are fixed, creation is idempotent and zero bindings do not inherit defaults", async () => {
  const f = await fixture();
  try {
    const service = new ExpertService(f.library, f.builds),
      skill = await f.library.create("a", randomUUID(), "Table", source());
    const setting = await f.builds.setDefault(
      "a",
      skill.id,
      true,
      skill.currentVersionId!,
      0,
      randomUUID(),
    );
    await wait(
      async () =>
        (await f.library.detail("a", skill.id)).setting?.enabled === 1,
    );
    const expert = await f.a.request<
      Awaited<ReturnType<ExpertService["save"]>>
    >("/experts", "POST", {
      clientRequestId: randomUUID(),
      definition: expertDefinition(),
    });
    await assert.rejects(
      f.a.request("/sessions", "POST", {
        clientRequestId: randomUUID(),
        expertVersionId: expert.currentVersionId,
      }),
      code("EXPERT_NOT_READY"),
    );
    await f.a.request(
      `/expert-versions/${expert.currentVersionId}/install`,
      "POST",
      {},
    );
    const request = {
      clientRequestId: randomUUID(),
      expertVersionId: expert.currentVersionId,
      title: "Expert",
    };
    const one = await f.a.request<SessionDetail>("/sessions", "POST", request),
      duplicate = await f.a.request<SessionDetail>(
        "/sessions",
        "POST",
        request,
      );
    assert.equal(one.id, duplicate.id);
    assert.equal(one.capabilitySnapshot!.skills.length, 0);
    assert.equal(one.expertSnapshot!.versionId, expert.currentVersionId);
    assert.match(one.expertSnapshot!.instructions, /Review the supplied/);
    let captured:
      import("../src/runtime/controller.js").ConversationOptions | undefined;
    f.controller.open = async (sessionId, _token, options) => {
      captured = options;
      return {
        run: async () => ({
          sessionId,
          generation: 1,
          status: "succeeded" as const,
          stopped: true,
          environment: "closed" as const,
        }),
        close: async () => {},
        terminate: async () => {},
      };
    };
    const sent = await f.a.send(one.id, randomUUID(), "Review this material");
    await wait(
      async () =>
        (await f.store.message(sent.message.id))?.status === "succeeded",
    );
    assert.equal(captured!.expert!.versionId, expert.currentVersionId);
    assert.equal(
      captured!.expert!.instructions,
      one.expertSnapshot!.instructions,
    );
    assert.equal(captured!.capabilities!.skills.length, 0);
    const two = await service.save(
      "a",
      randomUUID(),
      expertDefinition([], "New instructions"),
      expert.id,
      expert.currentVersionId,
    );
    assert.notEqual(two.currentVersionId, one.expertSnapshot!.versionId);
    assert.equal(
      (await f.store.session(one.id))!.expertSnapshot!.instructions,
      one.expertSnapshot!.instructions,
    );
    await assert.rejects(
      f.a.request("/sessions", "POST", {
        ...request,
        clientRequestId: randomUUID(),
        skillSelection: { skillVersionIds: [] },
      }),
      code("INVALID_EXPERT_SELECTION"),
    );
    await assert.rejects(
      f.b.request(`/experts/${expert.id}`),
      code("EXPERT_NOT_FOUND"),
    );
    f.driver.imageId = async () => "sha256:new-image";
    assert.equal(
      await service.latestInstall("a", expert.currentVersionId),
      null,
    );
    await assert.rejects(
      service.resolve("a", expert.currentVersionId),
      code("EXPERT_NOT_READY"),
    );
  } finally {
    await f.close();
  }
});

test("cancelled expert batch cannot be resurrected by a delayed retry, and restart completes cancellation", async () => {
  const f = await fixture();
  try {
    const service = new ExpertService(f.library, f.builds),
      skill = await f.library.create("a", randomUUID(), "Table", source());
    f.driver.build = async () => {
      throw new Error("fixture failure");
    };
    const expert = await service.save(
        "a",
        randomUUID(),
        expertDefinition([skill.currentVersionId!]),
      ),
      install = await service.install("a", expert.currentVersionId);
    await wait(
      async () =>
        (await service.installation("a", install.id)).state === "failed",
    );
    let unblock!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      }),
      began = new Promise<void>((resolve) => {
        started = resolve;
      }),
      original = f.builds.cancel.bind(f.builds);
    f.builds.cancel = async (user, id) => {
      started();
      await gate;
      return original(user, id);
    };
    const cancel = service.cancel("a", install.id);
    await began;
    const late = service.retry("a", install.id, install.items[0].request.id, 1);
    const rejected = assert.rejects(late, code("EXPERT_INSTALL_INACTIVE"));
    unblock();
    await cancel;
    await rejected;
    assert.equal(
      (await service.installation("a", install.id)).state,
      "cancelled",
    );
    assert.equal(
      (await f.builds.detail("a", install.items[0].request.id)).request.state,
      "failed",
    );
    const next = await service.install("a", expert.currentVersionId);
    await f.database.db
      .update(expertInstalls)
      .set({ status: "cancelling" })
      .where(eq(expertInstalls.id, next.id));
    await new ExpertService(f.library, f.builds).initialize();
    assert.equal((await service.installation("a", next.id)).state, "cancelled");
  } finally {
    await f.close();
  }
});

test('WorkBuddy original ZIP roundtrips, internal Skills stay scoped, edits preserve resources and sessions freeze native role', async()=>{
 const f=await fixture();
 try {
  const {workBuddyFiles}=await import('./workbuddy-fixture.js');
  const archive=await zip(workBuddyFiles()),requestId=randomUUID();
  const upload=()=>fetch(`${f.a.url}/api/expert-packages/import?clientRequestId=${requestId}`,{method:'POST',headers:{Authorization:'Bearer key-a'},body:new Uint8Array(archive)});
  const first=await upload();assert.equal(first.status,201);const expert=await first.json() as {id:string;currentVersionId:string;versions:{id:string;definition:import('../src/shared/experts.js').ExpertDefinition}[]};
  const duplicate=await upload();assert.equal(duplicate.status,201);assert.equal((await duplicate.json() as {id:string}).id,expert.id);
  assert.equal((await f.library.list('a')).length,0);
  const exported=await fetch(`${f.a.url}/api/expert-versions/${expert.currentVersionId}/export`,{headers:{Authorization:'Bearer key-a'}});
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()),archive);
  const forbidden=await fetch(`${f.b.url}/api/expert-versions/${expert.currentVersionId}/export`,{headers:{Authorization:'Bearer key-b'}});assert.equal(forbidden.status,404);
  const service=new ExpertService(f.library,f.builds),install=await service.install('a',expert.currentVersionId);
  await wait(async()=>(await service.installation('a',install.id)).state==='ready');
  const resolved=await service.resolve('a',expert.currentVersionId);
  assert.equal(resolved.expert.workbuddy!.agentName,'reviewer');assert.deepEqual(resolved.expert.workbuddy!.agents.reviewer.skills,['reference']);
  assert.equal(resolved.capabilities.skills[0].name,'reference');
  const files=await f.a.request<{path:string;text?:string}[]>(`/expert-versions/${expert.currentVersionId}/files`);
  const role=files.find(file=>file.path==='agents/reviewer.md')!.text!;
  const next=await f.a.request<{id:string;currentVersionId:string}>(`/experts/${expert.id}/package-versions`,'POST',{clientRequestId:randomUUID(),expectedVersionId:expert.currentVersionId,changes:[{path:'agents/reviewer.md',text:role+'\nNew rule.\n'}]});
  assert.notEqual(next.currentVersionId,expert.currentVersionId);
  assert.deepEqual(resolved.expert.workbuddy!.agents.reviewer.prompt,expert.versions[0].definition.workbuddy!.agents.reviewer.prompt);
  assert.equal((await f.a.request<{path:string}[]>(`/expert-versions/${next.currentVersionId}/files`)).some(file=>file.path==='avatars/other.png'),true);
  await assert.rejects(f.a.request(`/experts/${expert.id}/package-versions`,'POST',{clientRequestId:randomUUID(),expectedVersionId:expert.currentVersionId,changes:[{path:'agents/reviewer.md',text:role}]}),code('EXPERT_VERSION_CONFLICT'));
 }finally{await f.close();}
});

test('WorkBuddy MCP Token connection performs real handshake, keeps credentials encrypted and rejects cross-user use',async()=>{
 const {createServer}=await import('node:http');
 const {ExpertConnectionService}=await import('../src/service/experts/connections.js');
 const {parseWorkBuddy}=await import('../src/service/experts/workbuddy.js');
 const {workBuddyFiles}=await import('./workbuddy-fixture.js');
 const {expertConnections}=await import('../src/service/db/schema/index.js');
 const f=await fixture(),seen:string[]=[];
 const server=createServer((request,response)=>{void(async()=>{
  seen.push(String(request.headers.authorization));
  if(request.method==='GET'){response.writeHead(405);response.end();return;}
  if(request.headers.authorization!=='Bearer PRIVATE_FIXTURE_TOKEN'){response.writeHead(401);response.end();return;}
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  if(body.id===undefined){response.writeHead(202);response.end();return;}
  const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'lookup',description:'fixture tool',inputSchema:{type:'object'}}]};
  response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
 })().catch(()=>{response.writeHead(500);response.end();});});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 try{
  const bundle=parseWorkBuddy(workBuddyFiles(),Buffer.from('zip')).package;
  bundle.mcpServers={lookup:{type:'http',url:`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`,headers:{Authorization:'Bearer ${ACCESS_TOKEN}'},'x-workbuddy':{auth:{type:'token',tokenSchema:{fields:[{key:'ACCESS_TOKEN',type:'password',required:true}]}}}}};
  const service=new ExpertConnectionService(f.library.db,f.root);
  await assert.rejects(service.connect('a',bundle,'lookup',{},'http://localhost'),code('MCP_TOKEN_REQUIRED'));
  await assert.rejects(service.connect('a',bundle,'lookup',{ACCESS_TOKEN:'wrong'},'http://localhost'),code('MCP_CONNECTION_FAILED'));
  assert.equal((await service.connect('a',bundle,'lookup',{ACCESS_TOKEN:'PRIVATE_FIXTURE_TOKEN'},'http://localhost')).ready,true);
  assert.ok(seen.includes('Bearer PRIVATE_FIXTURE_TOKEN'));
  assert.equal((await service.status('a',bundle))[0].ready,true);
  assert.equal(JSON.stringify(await service.status('a',bundle)).includes('PRIVATE_FIXTURE_TOKEN'),false);
  const [row]=await f.library.db.select().from(expertConnections);assert.ok(!row.sealed.includes('PRIVATE_FIXTURE_TOKEN'));
  await assert.rejects(service.runtime('b',bundle),code('WORKBUDDY_CONNECTIONS_REQUIRED'));
  const runtime=await service.runtime('a',bundle);assert.equal((runtime.lookup as {headers:Record<string,string>}).headers.Authorization,'Bearer PRIVATE_FIXTURE_TOKEN');
  await service.disconnect('a',bundle,'lookup');await assert.rejects(service.runtime('a',bundle),code('WORKBUDDY_CONNECTIONS_REQUIRED'));
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await f.close();}
});

test('WorkBuddy MCP OAuth uses discovery, PKCE and user-bound one-time callback state',async()=>{
 const {createServer}=await import('node:http');
 const {ExpertConnectionService}=await import('../src/service/experts/connections.js');
 const {parseWorkBuddy}=await import('../src/service/experts/workbuddy.js');
 const {workBuddyFiles}=await import('./workbuddy-fixture.js');
 const f=await fixture();let origin='',challenge='',tokenCalls=0;
 const server=createServer((request,response)=>{void(async()=>{
  const url=new URL(request.url!,origin);let result:unknown;
  if(url.pathname==='/.well-known/oauth-protected-resource')result={resource:`${origin}/mcp`,authorization_servers:[origin],scopes_supported:['lookup']};
  else if(url.pathname==='/.well-known/oauth-authorization-server')result={issuer:origin,authorization_endpoint:`${origin}/authorize`,token_endpoint:`${origin}/token`,registration_endpoint:`${origin}/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']};
  else if(url.pathname==='/register'){const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);result={...JSON.parse(Buffer.concat(chunks).toString()),client_id:'fixture-client',client_id_issued_at:Math.floor(Date.now()/1000)};}
  else if(url.pathname==='/token'){
   const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);const params=new URLSearchParams(Buffer.concat(chunks).toString());
   assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),challenge);tokenCalls++;
   result={access_token:'OAUTH_FIXTURE_ACCESS',refresh_token:'OAUTH_FIXTURE_REFRESH',token_type:'Bearer',expires_in:3600};
  }else if(url.pathname==='/mcp'){
   if(request.headers.authorization!=='Bearer OAUTH_FIXTURE_ACCESS'){response.writeHead(401,{'WWW-Authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`});response.end();return;}
   if(request.method==='GET'){response.writeHead(405);response.end();return;}
   const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
   if(body.id===undefined){response.writeHead(202);response.end();return;}
   result={jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[]}};
  }else{response.writeHead(404);response.end();return;}
  response.writeHead(url.pathname==='/register'?201:200,{'Content-Type':'application/json'});response.end(JSON.stringify(result));
 })().catch(()=>{response.writeHead(500);response.end();});});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{
  const bundle=parseWorkBuddy(workBuddyFiles(),Buffer.from('zip')).package;
  bundle.mcpServers={oauth:{type:'http',url:`${origin}/mcp`,'x-workbuddy':{auth:{type:'oauth'}}}};
  const service=new ExpertConnectionService(f.library.db,f.root),started=await service.connect('a',bundle,'oauth',{},'http://localhost');
  assert.equal(started.ready,false);assert.ok(started.authorizationUrl);
  const authorization=new URL(started.authorizationUrl!);challenge=authorization.searchParams.get('code_challenge')!;assert.ok(challenge);
  const state=authorization.searchParams.get('state')!;
  await assert.rejects(service.finish('b',[bundle],state,'fixture-code','http://localhost'),code('MCP_NOT_FOUND'));
  await assert.rejects(service.finish('a',[bundle],state+'bad','fixture-code','http://localhost'),code('MCP_OAUTH_EXPIRED'));
  await service.finish('a',[bundle],state,'fixture-code','http://localhost');assert.equal(tokenCalls,1);
  const runtime=await service.runtime('a',bundle);assert.equal((runtime.oauth as {headers:Record<string,string>}).headers.Authorization,'Bearer OAUTH_FIXTURE_ACCESS');
  await assert.rejects(service.finish('a',[bundle],state,'fixture-code','http://localhost'),code('MCP_OAUTH_EXPIRED'));
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await f.close();}
});
