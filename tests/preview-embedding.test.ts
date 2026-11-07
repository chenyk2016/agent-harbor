import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDockerDriver } from "../src/service/applications/docker.js";
import { OpenSandboxPreviewProvider } from "../src/opensandbox/preview-provider.js";

test("OpenSandbox serializes the preview origin for public previews and omits it for production", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-preview-embedding-"));
  const configurations: Record<string, unknown>[] = [];
  const provider = new OpenSandboxPreviewProvider({
    async create({ configPath }) {
      configurations.push(JSON.parse(await readFile(configPath, "utf8")));
      return randomUUID();
    },
    async kill() {},
    async endpoint() { return new URL("http://127.0.0.1:3000"); },
  }, new AppDockerDriver(root), root, new URL("http://127.0.0.1:8580"), "fixture-only-preview-access-key");
  provider.findOwned = async () => [];
  provider.inspect = async () => "running" as const;
  try {
    for (const target of ["preview", "production"] as const) {
      const appId = randomUUID();
      await provider.create({
        build: { id: randomUUID(), appId, revisionId: randomUUID(), target,
          basePath: `/${target === "preview" ? "preview" : "apps"}/${appId}/`, imageId: "sha256:" + "a".repeat(64) },
        deploymentId: randomUUID(), databaseUrl: "postgres://fixture-only",
        previewParentOrigin: "https://studio.example.net",
      });
    }
    assert.equal(configurations[0].environment, "preview");
    assert.equal(configurations[0].previewParentOrigin, "https://studio.example.net");
    assert.equal(configurations[0].visitorAuth, undefined);
    assert.equal(configurations[1].environment, "production");
    assert.equal(configurations[1].previewParentOrigin, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
