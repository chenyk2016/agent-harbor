/** 应用基础契约：真实Git、文件边界、数据迁移限制和网关目标校验。 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationSources } from "../src/service/applications/source-store.js";
import {
  parseManifest,
  migrationPlan,
  manifestHash,
} from "../src/service/applications/manifest.js";
import { applicationRoutes } from "../src/service/applications/edge.js";
import { validateArtifact } from "../src/service/applications/builder.js";
import type { AppDeployment } from "../src/service/applications/docker.js";
import { ApplicationSecrets } from "../src/service/applications/secrets.js";

const manifest = () =>
  parseManifest({
    formatVersion: 1,
    template: "react-node-v1",
    tables: {
      signups: {
        fields: { name: { type: "text", maxLength: 80 } },
        publicCreate: true,
        publicRead: false,
      },
    },
  });

test("app manifest requires explicit data policies and rejects SQL identifiers and unsupported types", () => {
  const valid = manifest();
  assert.equal(valid.tables.signups.publicRead, false);
  assert.throws(
    () =>
      parseManifest({ ...valid, tables: { 'x";DROP': valid.tables.signups } }),
    /IDENTIFIER/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...valid,
        tables: { x: { ...valid.tables.signups, publicRead: undefined } },
      }),
    /POLICY/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...valid,
        tables: {
          x: {
            ...valid.tables.signups,
            fields: { row_version: { type: "text" } },
          },
        },
      }),
    /IDENTIFIER/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...valid,
        tables: {
          x: { ...valid.tables.signups, fields: { name: { type: "sql" } } },
        },
      }),
    /FIELD_TYPE/,
  );
  assert.throws(
    () =>
      parseManifest({
        ...valid,
        tables: {
          x: {
            ...valid.tables.signups,
            fields: { name: { type: "text", maxLength: -1 } },
          },
        },
      }),
    /FIELD_LENGTH/,
  );
});

test("app migration accepts nullable expansion, rejects removal and type changes, hashes fields independently of input order", () => {
  const previous = manifest(),
    next = manifest();
  next.tables.signups.fields.email = { type: "text" };
  assert.equal(migrationPlan(previous, next).length, 1);
  assert.match(migrationPlan(previous, next)[0], /ADD COLUMN "email" text$/);
  assert.throws(() => migrationPlan(next, previous), /DESTRUCTIVE/);
  const bad = manifest();
  bad.tables.signups.fields.name = { type: "boolean" };
  assert.throws(() => migrationPlan(previous, bad), /DESTRUCTIVE/);
  const reordered = manifest();
  reordered.tables.signups.fields = {
    email: { type: "text" },
    name: { type: "text", maxLength: 80 },
  };
  assert.equal(manifestHash(next), manifestHash(reordered));
});

test("Git app snapshots are immutable, exclude environment/cache files, and export an older source after edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-app-sources-")),
    id = randomUUID();
  try {
    const source = join(root, "work");
    await mkdir(join(source, "src"), { recursive: true });
    for (const [name, value] of Object.entries({
      "harbor-app.json": JSON.stringify(manifest()),
      "package.json": "{}",
      "package-lock.json": "{}",
      "index.html": "first",
      ".env": "PRIVATE_VALUE",
      "src/main.ts": "first",
    }))
      await writeFile(join(source, name), value);
    const sources = new ApplicationSources(join(root, "private"));
    const first = await sources.snapshot(id, source);
    await writeFile(join(source, "src/main.ts"), "second");
    const second = await sources.snapshot(id, source);
    assert.notEqual(first.commit, second.commit);
    assert.notEqual(first.sourceHash, second.sourceHash);
    const output = join(root, "export");
    await sources.export(first, output);
    assert.equal(await readFile(join(output, "src/main.ts"), "utf8"), "first");
    await assert.rejects(readFile(join(output, ".env")), { code: "ENOENT" });
    await assert.rejects(
      sources.export({ ...first, sourceHash: "wrong" }, join(root, "bad")),
      /MISMATCH/,
    );
    await assert.rejects(
      sources.snapshot("../escape", source),
      /INVALID_APP_ID/,
    );
    await symlink("/etc/passwd", join(source, "src/escape"));
    await assert.rejects(sources.snapshot(id, source), /SYMLINK_DENIED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway routes require exact app/environment and local validated ports, strip platform credentials", () => {
  const appId = randomUUID(),
    id = randomUUID();
  const deployment: AppDeployment = {
    id,
    appId,
    container: "fixture",
    hostPort: 12345,
    environment: "production",
    build: {
      id: randomUUID(),
      appId,
      revisionId: "a".repeat(40),
      target: "production",
      imageId: "sha256:" + "a".repeat(64),
      basePath: `/apps/${appId}/`,
    },
  };
  const routes = JSON.stringify(applicationRoutes([deployment], "127.0.0.1"));
  assert.match(routes, /Cookie/);
  assert.match(routes, /127.0.0.1:12345/);
  assert.throws(
    () => applicationRoutes([deployment, deployment], "127.0.0.1"),
    /INVALID_EDGE_DEPLOYMENT/,
  );
  assert.throws(
    () => applicationRoutes([{ ...deployment, hostPort: 70000 }], "127.0.0.1"),
    /INVALID_EDGE_DEPLOYMENT/,
  );
  assert.throws(
    () =>
      applicationRoutes([{ ...deployment, appId: randomUUID() }], "127.0.0.1"),
    /INVALID_EDGE_DEPLOYMENT/,
  );
  assert.throws(
    () => applicationRoutes([deployment], "169.254.169.254"),
    /UPSTREAM_HOST/,
  );
});

test("artifact validation allows contained package links but rejects links outside the output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-app-output-"));
  try {
    await mkdir(join(root, "site"));
    await mkdir(join(root, "server"));
    for (const file of ["site/index.html", "server/index.mjs", "package.json"])
      await writeFile(join(root, file), "{}");
    await symlink("./package.json", join(root, "inside"));
    await validateArtifact(root);
    await symlink("/etc/passwd", join(root, "outside"));
    await assert.rejects(validateArtifact(root), /SYMLINK_DENIED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("application secrets survive service reopen and reject swapped environment identity or another store key", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-app-secrets-"));
  try {
    const box = new ApplicationSecrets(root),
      sealed = await box.seal("database-password", "app-a:production");
    assert(!sealed.includes("database-password"));
    assert.equal(
      await new ApplicationSecrets(root).open(sealed, "app-a:production"),
      "database-password",
    );
    await assert.rejects(box.open(sealed, "app-b:production"));
    await assert.rejects(
      new ApplicationSecrets(join(root, "other")).open(
        sealed,
        "app-a:production",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
