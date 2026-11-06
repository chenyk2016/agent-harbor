import { access, statfs, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { identityFromEnvironment } from "../../service/config.js";
import { WorkbenchAuth } from "../../service/identity/workbench.js";
import { resolveLlmSettings } from "../../service/llm/client.js";
import { applicationConfiguration } from "../../service/applications/config.js";
import { langfuseConfig } from "../../service/tracing/config.js";
import {
  run,
  request,
  projectRoot,
  hash,
  exists,
  type Config,
  privateJson,
  OpsError,
  verifyReleaseFiles,
} from "./common.js";
export interface Check {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}
export async function doctor(
  c: Config,
  options: { runtime?: boolean; service?: boolean } = {},
) {
  const checks: Check[] = [];
  const tracing = langfuseConfig(c.env);
  checks.push({ name: "langfuse-configuration", status: tracing.state === "invalid" ? "failed" : tracing.state === "disabled" ? "skipped" : "passed",
    detail: tracing.state === "invalid" ? "missing or invalid fields: " + tracing.issues.join(",") : tracing.state === "disabled" ? "not configured; no callback or exporter" : "enabled by complete configuration; cloud delivery verified separately" });
  const check = async (name: string, action: () => Promise<string>) => {
    try {
      checks.push({ name, status: "passed", detail: await action() });
    } catch (e) {
      checks.push({
        name,
        status: "failed",
        detail: e instanceof OpsError ? e.code : "CHECK_FAILED",
      });
    }
  };
  if (await exists(join(projectRoot, "release-manifest.json")))
    await check("release-integrity", async () => {
      await verifyReleaseFiles(projectRoot);
      return "release file hashes match";
    });
  else
    checks.push({
      name: "release-integrity",
      status: "skipped",
      detail: "source checkout, not a packaged release",
    });
  await check("node", async () => {
    const [a, b] = process.versions.node.split(".").map(Number);
    if (a < 24 || (a === 24 && b < 19))
      throw new OpsError("NODE_24_19_REQUIRED");
    return process.versions.node;
  });
  let llm: ReturnType<typeof resolveLlmSettings>["settings"];
  await check("configuration", async () => {
    const gateway = resolveLlmSettings(c.env);
    llm = gateway.settings;
    const identity = identityFromEnvironment(c.env, !!llm?.walletProxyUrl);
    const issues = [...identity.issues];
    if (gateway.missing.length) issues.push("Managed gateway requires " + gateway.missing.join(", "));
    const app = applicationConfiguration((_feature, reason) => issues.push(reason), c.env);
    return [app ? "application configuration present" : "application module unavailable", ...issues].join("; ");
  });
  await check("workspace", async () => {
    await access(c.env.AH_DATA_DIR!);
    const fs = await statfs(c.env.AH_DATA_DIR!);
    const available = fs.bavail * fs.bsize;
    if (available < 1024 ** 3)
      throw new OpsError("AT_LEAST_1_GIB_FREE_REQUIRED");
    return "directory accessible; at least 1 GiB available";
  });
  await check("python-lock", async () => {
    await run("python3", ["-c", 'import fcntl,os; print("available")']);
    return "Python and flock available";
  });
  await check("git", async () => {
    await run("git", ["--version"]);
    return "available";
  });
  await check("docker", async () => {
    const info = JSON.parse(
      await run("docker", ["info", "--format", "{{json .}}"]),
    );
    if (info.OSType !== "linux")
      throw new OpsError("LINUX_CONTAINERS_REQUIRED");
    return "Linux engine " + info.Architecture;
  });
  await check("compose", async () => {
    await run("docker", ["compose", "version"]);
    return "available";
  });
  await check("runtime-image", async () => {
    const value = JSON.parse(
      await run("docker", ["image", "inspect", c.env.AH_SKILL_IMAGE!]),
    );
    if (!value[0]?.Id) throw new OpsError("RUNTIME_IMAGE_MISSING");
    const manifest = join(projectRoot, "release-manifest.json");
    if (await exists(manifest)) {
      const m = JSON.parse(await readFile(manifest, "utf8"));
      if (m.runtimeImageId && m.runtimeImageId !== value[0].Id)
        throw new OpsError("RELEASE_RUNTIME_IMAGE_MISMATCH");
    }
    return value[0].Id;
  });
  await check("control-database", async () => {
    const pool = new Pool({
      connectionString: c.env.AH_DATABASE_URL,
      connectionTimeoutMillis: 3000,
      max: 1,
    });
    try {
      const server = await pool.query("SHOW server_version_num");
      if (Number(server.rows[0].server_version_num) < 170000)
        throw new OpsError("POSTGRES_17_OR_LATER_REQUIRED");
      const applied = await pool.query(
        "SELECT name,checksum FROM schema_migrations",
      );
      for (const file of (
        await readdir(join(projectRoot, "migrations"))
      ).filter((n) => n.endsWith(".sql"))) {
        if (
          applied.rows.find((r) => r.name === file)?.checksum !==
          hash(await readFile(join(projectRoot, "migrations", file)))
        )
          throw new OpsError("MIGRATION_MISSING_OR_CHANGED");
      }
      const { workbench } = identityFromEnvironment(c.env, !!llm?.walletProxyUrl);
      if (workbench) await new WorkbenchAuth(pool, workbench).checkStorage();
      return "database reachable; migration checksums match";
    } finally {
      await pool.end();
    }
  });
  const gateway = llm;
  if (gateway) await check("gateway", async () => {
    const r = await request(
      gateway.managementUrl + "/health/liveness",
      { headers: { Authorization: "Bearer " + gateway.masterKey } },
    );
    if (!r.ok) throw new OpsError("GATEWAY_UNAVAILABLE");
    return "free liveness only; model not called";
  });
  else checks.push({ name: "gateway", status: "skipped", detail: "managed gateway unavailable or disabled" });
  if (options.service)
    await check("service", async () => {
      const base = c.env.AH_SERVICE_URL!;
      const r = await request(base + "/api/health");
      const body = (await r.json()) as any;
      if (!r.ok || !body.alive || !body.ready)
        throw new OpsError("SERVICE_NOT_READY");
      const page = await request(base + "/");
      if (!page.ok || !(await page.text()).includes("script"))
        throw new OpsError("WEB_ASSETS_UNAVAILABLE");
      const protectedApi = await request(base + "/api/admin/operations/status");
      if (protectedApi.status !== 401)
        throw new OpsError("UNAUTHENTICATED_ADMIN_NOT_REJECTED");
      return "ready; web assets available; admin requires authentication";
    });
  if (options.runtime)
    await check("sandbox-probe", async () => {
      const name = "harbor-probe-" + randomUUID();
      try {
        await run(
          "docker",
          [
            "run",
            "--name",
            name,
            "--rm",
            "--network",
            "none",
            "--user",
            "1000:1000",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--security-opt",
            "seccomp=" + join(projectRoot, "infra/seccomp.json"),
            "--security-opt",
            "systempaths=unconfined",
            "--read-only",
            "--pids-limit",
            "64",
            "--memory",
            "256m",
            "--tmpfs",
            "/tmp:rw,nosuid,size=64m,mode=1777",
            "--entrypoint",
            "node",
            c.env.AH_SKILL_IMAGE!,
            "--input-type=module",
            "-e",
            "import {checkSandbox} from '/platform/runtime/dist/src/agent/sandbox.js'; await checkSandbox()",
          ],
          { timeout: 15000 },
        );
        return "actual namespace probe; not a full isolation audit";
      } finally {
        await run("docker", ["rm", "-f", name]).catch(() => {});
      }
    });
  else
    checks.push({
      name: "sandbox-probe",
      status: "skipped",
      detail: "use --runtime for actual namespace probe",
    });
  return {
    format: 1,
    sampledAt: new Date().toISOString(),
    installationId: c.installation.id,
    passed: checks.every((c) => c.status !== "failed"),
    checks,
    realModelRequests: 0,
  };
}
