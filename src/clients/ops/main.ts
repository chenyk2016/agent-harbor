#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  configure,
  install,
  initialize,
  serviceUnit,
  monitorUnits,
} from "./install.js";
import { config, requireThat, privateJson, OpsError } from "./common.js";
import { doctor } from "./doctor.js";
import { backup, restore } from "./backup.js";
import { monitor } from "./monitor.js";
import { acceptance } from "./acceptance.js";
import { packageRelease } from "./package.js";
import { openDatabase } from "../../service/db/client.js";
import { TracingService } from "../../service/tracing/service.js";
import { langfuseConfig } from "../../service/tracing/config.js";
const help = `Agent Harbor 单机交付工具\nconfigure --dir ABSOLUTE_DIR --image IMAGE [--port 4318 --db-port 55432 --gateway-port 4320 --gateway-db-port 55433]\ninstall --dir DIR                      启动本实例依赖并受控迁移（停服）\ninit --dir DIR --admin USER [--model-config PRIVATE_JSON]\ndoctor --dir DIR [--runtime]            检查配置、版本、数据库、网关；--runtime实际沙箱探针\ntracing --dir DIR [--request-id ID]      观测状态及云端模型记录核实（不调用模型）\nstatus | verify --dir DIR               免费网页/API及依赖检查\nacceptance --dir DIR [--live --model-config PRIVATE_JSON --budget-rmb N] [--output DIR]\nbackup --dir DIR --output NEW_DIR        停服备份\nrestore --dir NEW_INSTANCE --source BACKUP  只恢复到空库/空数据根\nservice --dir DIR --user OS_USER        生成systemd配置，不修改操作系统\nmonitor --dir DIR                       单次采样；变化写本地文件或显式配置webhook\npackage --image IMAGE --output NEW_DIR [--local-only]  固定版本包\n所有报告脱敏；真实模型只有显式--live才调用。`;
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals: p } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      image: { type: "string" },
      port: { type: "string" },
      "db-port": { type: "string" },
      "gateway-port": { type: "string" },
      "gateway-db-port": { type: "string" },
      admin: { type: "string" },
      "model-config": { type: "string" },
      "request-id": { type: "string" },
      runtime: { type: "boolean" },
      live: { type: "boolean" },
      "budget-rmb": { type: "string" },
      output: { type: "string" },
      source: { type: "string" },
      user: { type: "string" },
      "local-only": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (v.help || !p.length) return { help };
  requireThat(p.length === 1, "ONE_COMMAND_REQUIRED");
  const command = p[0];
  if (command === "package") {
    requireThat(v.output && v.image, "OUTPUT_AND_IMAGE_REQUIRED");
    return packageRelease(v.output, v.image, v["local-only"]);
  }
  requireThat(v.dir, "EXPLICIT_INSTANCE_DIRECTORY_REQUIRED");
  if (command === "configure") {
    requireThat(v.image, "EXPLICIT_RUNTIME_IMAGE_REQUIRED");
    return configure(v.dir, v.image, {
      service: Number(v.port ?? 4318),
      control: Number(v["db-port"] ?? 55432),
      gateway: Number(v["gateway-port"] ?? 4320),
      gatewayDb: Number(v["gateway-db-port"] ?? 55433),
    });
  }
  const c = await config(v.dir);
  let result: any;
  switch (command) {
    case "tracing": {
      const db = openDatabase(c.env.AH_DATABASE_URL);
      const tracer = new TracingService(db.db, langfuseConfig(c.env));
      try {
        await tracer.initialize();
        if (v["request-id"]) {
          await tracer.confirm(v["request-id"]).catch(() => false);
          result = await tracer.evidence(v["request-id"]);
        } else result = await tracer.status();
      } finally { await tracer.close(); await db.close(); }
      break;
    }
    case "install":
      result = await install(c);
      break;
    case "init":
      requireThat(v.admin, "ADMIN_REQUIRED");
      result = await initialize(c, v.admin, v["model-config"]);
      break;
    case "doctor":
      result = await doctor(c, { runtime: v.runtime });
      break;
    case "status":
    case "verify":
      result = await doctor(c, { service: true, runtime: v.runtime });
      break;
    case "service":
      requireThat(v.user, "OS_USER_REQUIRED");
      await writeFile(
        join(c.dir, "agent-harbor.service"),
        serviceUnit(c, v.user),
        { mode: 0o600 },
      );
      const units = monitorUnits(c, v.user);
      await writeFile(
        join(c.dir, "agent-harbor-monitor.service"),
        units.service,
        { mode: 0o600 },
      );
      await writeFile(join(c.dir, "agent-harbor-monitor.timer"), units.timer, {
        mode: 0o600,
      });
      result = {
        generated: [
          "agent-harbor.service",
          "agent-harbor-monitor.service",
          "agent-harbor-monitor.timer",
        ].map((name) => join(c.dir, name)),
        installed: false,
      };
      break;
    case "backup":
      requireThat(v.output, "BACKUP_OUTPUT_REQUIRED");
      result = await backup(c, v.output);
      break;
    case "restore":
      requireThat(v.source, "BACKUP_SOURCE_REQUIRED");
      result = await restore(c, v.source);
      break;
    case "monitor":
      result = await monitor(c);
      break;
    case "acceptance":
      result = await acceptance(c, {
        live: v.live,
        budgetRmb: Number(v["budget-rmb"]),
        modelFile: v["model-config"],
        output: v.output,
      });
      break;
    default:
      throw new OpsError("UNKNOWN_COMMAND");
  }
  if (v.output && ["doctor", "verify", "status"].includes(command))
    await privateJson(resolve(v.output), result);
  if (result?.passed === false) process.exitCode = 1;
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await main(), null, 2));
  } catch (e) {
    console.error(
      JSON.stringify({
        passed: false,
        error: e instanceof OpsError ? e.code : "OPERATION_FAILED",
        hint: "See docs/deployment.md; credentials and raw subprocess errors are intentionally excluded.",
      }),
    );
    process.exitCode = 1;
  }
}
