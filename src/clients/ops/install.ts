import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  emptyDirectory,
  privateJson,
  dotenv,
  run,
  requireThat,
  environment,
  updateEnv,
  projectRoot,
  type Config,
  exists,
  readJson,
  hash,
  verifyReleaseFiles,
} from "./common.js";
import { lockSession } from "../../runtime/storage.js";
import { parsePrice } from "../../service/wallet/service.js";
import { tokenHash } from "../../service/auth.js";
import { openDatabase } from "../../service/db/client.js";
import { applyMigrations } from "../../service/db/migrate.js";
import { LlmService } from "../../service/llm/service.js";
import { McpSecrets } from "../../service/mcp/secrets.js";
import { llmSettings } from "../../service/llm/client.js";

export async function configure(
  dir: string,
  image: string,
  ports = { service: 4318, control: 55432, gateway: 4320, gatewayDb: 55433 },
) {
  dir = resolve(dir);
  requireThat(
    image && /^[A-Za-z0-9][A-Za-z0-9_./:@-]+$/.test(image),
    "EXPLICIT_RUNTIME_IMAGE_REQUIRED",
  );
  const values = [...Object.values(ports), ports.service - 1];
  requireThat(
    values.every((n) => Number.isInteger(n) && n > 1024 && n <= 65535) &&
      new Set(values).size === values.length,
    "INVALID_PORTS",
  );
  await emptyDirectory(dir);
  const id = randomUUID(),
    secret = () => randomBytes(32).toString("hex"),
    controlPassword = secret(),
    gatewayPassword = secret();
  await mkdir(join(dir, "data"), { mode: 0o700 });
  const env = {
    AH_DATA_DIR: join(dir, "data"),
    AH_IMAGE: image,
    AH_SKILL_IMAGE: image,
    AH_SERVICE_PORT: String(ports.service),
    AH_PUBLIC_ORIGIN: `http://127.0.0.1:${ports.service}`,
    AH_SERVICE_URL: `http://127.0.0.1:${ports.service}`,
    AH_DATABASE_URL: `postgres://harbor:${controlPassword}@127.0.0.1:${ports.control}/harbor`,
    AH_CONTROL_DB_PORT: String(ports.control),
    AH_CONTROL_DB_PASSWORD: controlPassword,
    AH_GATEWAY_DB_PORT: String(ports.gatewayDb),
    AH_GATEWAY_DB_PASSWORD: gatewayPassword,
    AH_LITELLM_DATABASE_URL: `postgres://litellm:${gatewayPassword}@127.0.0.1:${ports.gatewayDb}/litellm`,
    AH_LLM_ENABLED: "true",
    AH_LITELLM_PORT: String(ports.gateway),
    AH_LITELLM_MANAGEMENT_URL: `http://127.0.0.1:${ports.gateway}`,
    AH_LITELLM_INFERENCE_URL: `http://host.docker.internal:${ports.gateway}`,
    AH_LITELLM_MASTER_KEY: "sk-" + secret(),
    AH_LITELLM_SALT_KEY: secret(),
    AH_WALLET_ENABLED: "true",
    AH_WALLET_INFERENCE_URL: `http://host.docker.internal:${ports.service}/inference`,
    AH_LLM_POLICY_FILE: join(projectRoot, "infra/deployment/policy.json"),
    AH_APPLICATIONS_ENABLED: "0",
    AH_KEY_LOGIN: "true",
    AH_ADMIN_USERS: "",
    AH_TASK_TIMEOUT_MS: "0",
    AH_MAX_TURNS: "0",
    AH_MAX_BUDGET_USD: "0",
    AH_CAPACITY: "4",
  };
  await writeFile(join(dir, "harbor.env"), dotenv(env), { mode: 0o600 });
  await privateJson(join(dir, "installation.json"), {
    format: 1,
    id,
    runtimeImage: image,
    createdAt: new Date().toISOString(),
  });
  return {
    configured: true,
    directory: dir,
    applications: false,
    payments: false,
  };
}
export function composeArgs(c: Config) {
  return [
    "compose",
    "--project-name",
    "harbor-" + c.installation.id.slice(0, 8),
    "--env-file",
    join(c.dir, "harbor.env"),
    "-f",
    join(projectRoot, "infra/deployment/compose.yml"),
    ...(c.env.AH_INFERENCE_BIND_HOST
      ? ["-f", join(projectRoot, "infra/deployment/linux.override.yml")]
      : []),
  ];
}
export async function compose(c: Config, args: string[]) {
  return run("docker", [...composeArgs(c), ...args], {
    env: environment(c),
    timeout: 180000,
  });
}
export async function install(c: Config) {
  const release = await offlineLock(c);
  try {
    if (process.platform === "linux") {
      const bridgeHost = (
        await run("docker", [
          "network",
          "inspect",
          "bridge",
          "--format",
          "{{(index .IPAM.Config 0).Gateway}}",
        ])
      ).trim();
      await updateEnv(c, {
        AH_INFERENCE_BIND_HOST: bridgeHost,
        AH_INFERENCE_PORT: String(Number(c.env.AH_SERVICE_PORT) - 1),
        AH_WALLET_INFERENCE_URL: `http://host.docker.internal:${Number(c.env.AH_SERVICE_PORT) - 1}/inference`,
      });
    }
    await verifyReleaseFiles(projectRoot);
    const inspected = JSON.parse(
      await run("docker", ["image", "inspect", c.env.AH_IMAGE!]),
    );
    if (await exists(join(projectRoot, "release-manifest.json"))) {
      const m = await readJson(join(projectRoot, "release-manifest.json"));
      requireThat(
        m.runtimeImageId === inspected[0].Id,
        "RELEASE_RUNTIME_IMAGE_MISMATCH",
      );
    }

    await compose(c, ["up", "-d", "--wait"]);
    const db = openDatabase(c.env.AH_DATABASE_URL);
    try {
      const migrations = await applyMigrations(
        db.pool,
        join(projectRoot, "migrations"),
      );
      if (
        !(await exists(join(c.dir, "bootstrap.json"))) &&
        Number(
          (await db.pool.query("SELECT count(*) n FROM users")).rows[0].n,
        ) === 0
      )
        await db.pool.query(
          'UPDATE wallet_settings SET "signupMicro"=0,"plusMicro"=0 WHERE id=\'platform\'',
        );
      return { installed: true, migrations };
    } finally {
      await db.close();
    }
  } finally {
    await release();
  }
}
export async function offlineLock(c: Config) {
  const dir = join(c.env.AH_DATA_DIR!, ".service");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return lockSession(dir);
}
export async function loadModelFile(path: string) {
  const m = await readJson(path);
  requireThat(
    m && m.provider && m.deployment && m.cost && m.price,
    "MODEL_CONFIG_REQUIRES_PROVIDER_DEPLOYMENT_COST_PRICE",
  );
  requireThat(
    [
      "anthropic",
      "anthropic_compatible",
      "openai_chat",
      "openai_responses",
    ].includes(m.provider.format) &&
      typeof m.provider.apiKey === "string" &&
      m.provider.apiKey.trim().length > 0 &&
      m.provider.apiKey.length <= 4096 &&
      !/[\x00-\x1f]/.test(m.provider.apiKey) &&
      typeof m.provider.name === "string" &&
      m.provider.name.trim().length > 0 &&
      m.provider.name.length <= 200 &&
      !/[\x00-\x1f]/.test(m.provider.name),
    "INVALID_BOOTSTRAP_PROVIDER",
  );
  const url = new URL(m.provider.apiBase);
  requireThat(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "INVALID_BOOTSTRAP_PROVIDER_URL",
  );
  requireThat(
    typeof m.deployment.name === "string" &&
      m.deployment.name.trim().length > 0 &&
      m.deployment.name.length <= 200 &&
      !/[\x00-\x1f]/.test(m.deployment.name) &&
      typeof m.deployment.upstreamModel === "string" &&
      /^[a-zA-Z0-9_.:/@-]+$/.test(m.deployment.upstreamModel) &&
      m.deployment.tools === true &&
      m.deployment.streaming === true,
    "BOOTSTRAP_REQUIRES_TOOL_STREAM_MODEL",
  );
  for (const [obj, keys] of [
    [
      m.cost,
      [
        "inputUsdPerMillion",
        "outputUsdPerMillion",
        "cacheReadUsdPerMillion",
        "cacheWriteUsdPerMillion",
      ],
    ],
    [m.price, ["input", "output", "cacheRead", "cacheWrite"]],
  ] as const)
    for (const k of keys)
      requireThat(
        (typeof obj[k] === "string" || typeof obj[k] === "number") &&
          Number.isFinite(Number(obj[k])) &&
          String(obj[k]).trim().length > 0 &&
          Number(obj[k]) >= 0 &&
          Number(obj[k]) <= (obj === m.cost ? 1000 : 1000000),
        "INVALID_BOOTSTRAP_RATE",
      );
  parsePrice(m.price);
  requireThat(
    m.cost.timeoutSeconds === undefined ||
      (Number.isInteger(Number(m.cost.timeoutSeconds)) &&
        Number(m.cost.timeoutSeconds) >= 1 &&
        Number(m.cost.timeoutSeconds) <= 3600),
    "INVALID_BOOTSTRAP_TIMEOUT",
  );
  requireThat(
    Object.keys(m.cost).every((k) =>
      [
        "inputUsdPerMillion",
        "outputUsdPerMillion",
        "cacheReadUsdPerMillion",
        "cacheWriteUsdPerMillion",
        "timeoutSeconds",
      ].includes(k),
    ),
    "INVALID_BOOTSTRAP_COST_FIELD",
  );
  for (const k of ["params", "capabilities"])
    requireThat(
      m.deployment[k] === undefined ||
        (m.deployment[k] &&
          typeof m.deployment[k] === "object" &&
          !Array.isArray(m.deployment[k])),
      "INVALID_BOOTSTRAP_MODEL_OBJECT",
    );
  requireThat(
    m.deployment.allowedUsers === undefined ||
      (Array.isArray(m.deployment.allowedUsers) &&
        m.deployment.allowedUsers.every(
          (x: unknown) => typeof x === "string" && x.length > 0,
        )),
    "INVALID_BOOTSTRAP_ALLOWED_USERS",
  );
  return m;
}
export async function initialize(
  c: Config,
  userId: string,
  modelFile?: string,
) {
  requireThat(/^[A-Za-z0-9_-]{1,64}$/.test(userId), "INVALID_ADMIN_ID");
  const setup = modelFile ? await loadModelFile(modelFile) : undefined,
    digest = setup ? hash(JSON.stringify(setup)) : null;
  const release = await offlineLock(c);
  try {
    const marker = join(c.dir, "bootstrap.json"),
      directory = join(c.env.AH_DATA_DIR!, ".service"),
      path = join(directory, "access-keys.json");
    let state: any = (await exists(marker)) ? await readJson(marker) : null;
    if (state) {
      requireThat(state.userId === userId, "ADMIN_ALREADY_INITIALIZED");
      if (setup)
        requireThat(
          state.modelDigest === digest,
          "BOOTSTRAP_CONFIG_CHANGED_USE_ADMIN_UI",
        );
      if (state.phase === "ready")
        return {
          initialized: true,
          reused: true,
          modelConfigured: !!state.deploymentId,
        };
      requireThat(
        state.phase !== "credentials-pending",
        "BOOTSTRAP_CREDENTIAL_WRITE_UNCONFIRMED",
      );
      requireThat(
        !state.modelDigest || setup,
        "BOOTSTRAP_RESUME_REQUIRES_SAME_MODEL_CONFIG",
      );
      const token = (
        await readFile(join(c.dir, "first-admin.key"), "utf8")
      ).trim();
      const keys = await readJson(path);
      requireThat(
        keys.some(
          (k: any) => k.userId === userId && k.tokenHash === tokenHash(token),
        ),
        "BOOTSTRAP_CREDENTIAL_MISMATCH",
      );
    } else {
      requireThat(
        !(await exists(path)) &&
          !(await exists(join(c.dir, "first-admin.key"))),
        "EXISTING_KEYS_REQUIRE_MANUAL_ADOPTION",
      );
      // This secret belongs only to the initial operator command, not the service environment.
      const token = process.env.AH_BOOTSTRAP_ADMIN_KEY;
      requireThat(token, "AH_BOOTSTRAP_ADMIN_KEY_REQUIRED");
      requireThat(/^[A-Za-z0-9_-]{32,128}$/.test(token), "INVALID_AH_BOOTSTRAP_ADMIN_KEY");
      state = {
        userId,
        modelDigest: digest,
        providerId: null,
        deploymentId: null,
        phase: "credentials-pending",
      };
      await privateJson(marker, state);
      await writeFile(join(c.dir, "first-admin.key"), token + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await privateJson(path, [{ userId, tokenHash: tokenHash(token) }]);
      state.phase = "admin-created";
      await privateJson(marker, state);
    }
    await updateEnv(c, { AH_ADMIN_USERS: userId });
    if (setup) {
      const db = openDatabase(c.env.AH_DATABASE_URL);
      try {
        const service = new LlmService(db.db, directory, llmSettings(c.env)!);
        // 本实例停服锁下按固定配置恢复；零或一个精确匹配，歧义时拒绝自动选择。
        const providers = (
          await db.pool.query(
            'SELECT * FROM llm_providers WHERE name=$1 AND format=$2 AND "apiBase"=$3',
            [
              setup.provider.name,
              setup.provider.format,
              setup.provider.apiBase.replace(/\/$/, ""),
            ],
          )
        ).rows;
        requireThat(providers.length <= 1, "BOOTSTRAP_PROVIDER_AMBIGUOUS");
        let provider = providers[0];
        if (provider) {
          const secrets = (
            await db.pool.query(
              'SELECT secret FROM llm_provider_secrets WHERE "providerId"=$1 AND "retiredAt" IS NULL ORDER BY version DESC',
              [provider.id],
            )
          ).rows;
          requireThat(secrets.length === 1, "BOOTSTRAP_SECRET_AMBIGUOUS");
          requireThat(
            (
              await new McpSecrets(join(directory, "llm")).open(
                secrets[0].secret,
              )
            ).apiKey === setup.provider.apiKey,
            "BOOTSTRAP_SECRET_MISMATCH",
          );
        } else provider = await service.addProvider(setup.provider, userId);
        state.providerId = provider.id;
        state.phase = "provider-created";
        await privateJson(marker, state);
        const models = (
          await db.pool.query(
            'SELECT d.id FROM llm_deployments d JOIN llm_model_versions v ON v.id=d."currentVersionId" WHERE d.name=$1 AND v."providerId"=$2 AND v."upstreamModel"=$3 AND d."archivedAt" IS NULL',
            [
              setup.deployment.name,
              provider.id,
              setup.deployment.upstreamModel,
            ],
          )
        ).rows;
        requireThat(models.length <= 1, "BOOTSTRAP_MODEL_AMBIGUOUS");
        const detail = models[0]
          ? await service.deploymentDetail(models[0].id)
          : await service.createDeployment(
              {
                ...setup.deployment,
                providerId: provider.id,
                cost: setup.cost,
                price: setup.price,
              },
              userId,
            );
        state.deploymentId = detail.deployment.id;
        state.phase = "model-created";
        await privateJson(marker, state);
        await service.syncDeployment(state.deploymentId);
        const verified = await service.deploymentDetail(state.deploymentId);
        requireThat(
          verified.versions.some(
            (v) =>
              v.id === verified.deployment.currentVersionId &&
              v.state === "ready",
          ),
          "BOOTSTRAP_MODEL_SYNC_UNCONFIRMED",
        );
        await updateEnv(c, {
          AH_LLM_DEFAULT_DEPLOYMENT_ID: state.deploymentId,
        });
      } finally {
        await db.close();
      }
    }
    await privateJson(marker, { ...state, phase: "ready" });
    return {
      initialized: true,
      reused: false,
      modelConfigured: !!state.deploymentId,
      credentialFile: join(c.dir, "first-admin.key"),
    };
  } finally {
    await release();
  }
}
export function serviceUnit(c: Config, user: string) {
  requireThat(/^[a-z_][a-z0-9_-]*$/.test(user), "INVALID_SERVICE_USER");
  for (const path of [projectRoot, c.dir, process.execPath])
    requireThat(
      /^\/[A-Za-z0-9_./-]+$/.test(path),
      "SERVICE_PATH_REQUIRES_SIMPLE_ABSOLUTE_PATH",
    );
  return `[Unit]\nDescription=Agent Harbor\nAfter=network-online.target docker.service\nRequires=docker.service\n[Service]\nType=simple\nUser=${user}\nWorkingDirectory=${projectRoot}\nExecStart=${process.execPath} --env-file=${join(c.dir, "harbor.env")} ${join(projectRoot, "dist/src/service/server.js")}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=90\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`;
}

/** 只生成调度配置，实际启用由部署管理员完成。 */
export function monitorUnits(c: Config, user: string) {
  serviceUnit(c, user); // 复用路径和系统账号校验。
  return {
    service: `[Unit]\nDescription=Agent Harbor status change monitor\nAfter=network-online.target\n[Service]\nType=oneshot\nUser=${user}\nWorkingDirectory=${projectRoot}\nExecStart=${process.execPath} ${join(projectRoot, "dist/src/clients/ops/main.js")} monitor --dir ${c.dir}\nUMask=0077\n`,
    timer: `[Unit]\nDescription=Sample Agent Harbor status every minute\n[Timer]\nOnBootSec=90\nOnUnitActiveSec=60\nAccuracySec=5\nUnit=agent-harbor-monitor.service\n[Install]\nWantedBy=timers.target\n`,
  };
}
