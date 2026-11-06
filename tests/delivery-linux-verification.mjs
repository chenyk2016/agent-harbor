/** 在Linux控制容器中验证宿主模式交付；专用控制容器可管Docker，Agent绝不获得socket。 */
import { resolve, join } from "node:path";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
const bundle = resolve(
    process.env.AH_DELIVERY_BUNDLE ??
      "var/releases/reliable-delivery-2026-11-04-local",
  ),
  evidence = resolve("var/evidence/reliable-delivery/2026-11-04/linux-control");
await mkdir(evidence, { recursive: true, mode: 0o700 });
await mkdir(join(bundle, "tests"), { recursive: true });
await copyFile(
  "tests/delivery-verification.mjs",
  join(bundle, "tests/delivery-verification.mjs"),
);
const suffix = randomUUID().slice(0, 8),
  volume = "harbor-linux-check-deps-" + suffix,
  name = "harbor-linux-control-" + suffix;
const docker = (args) =>
  execFileSync("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
let passed = false;
try {
  docker([
    "volume",
    "create",
    "--label",
    "harbor.verification=delivery-linux",
    volume,
  ]);
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=volume,src=${volume},dst=/platform/runtime/node_modules`,
    "--entrypoint",
    "node",
    "agent-harbor:delivery-v29",
    "-e",
    "process.exit(0)",
  ]);
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "host",
    "--label",
    "harbor.verification=delivery-linux",
    "--mount",
    "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    "--mount",
    `type=bind,src=${bundle},dst=${bundle}`,
    "--mount",
    `type=volume,src=${volume},dst=${bundle}/node_modules`,
    "--mount",
    `type=bind,src=${evidence},dst=${evidence}`,
    "-w",
    bundle,
    "-e",
    "AH_DELIVERY_EVIDENCE=" + evidence,
    "-e",
    "AH_DELIVERY_TEST_IMAGE=agent-harbor:delivery-v29",
    "agent-harbor:delivery-linux-check",
    "tests/delivery-verification.mjs",
  ];
  const child = spawn("docker", args, { stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 600000);
  const code = await new Promise((r) => child.once("exit", r));
  clearTimeout(timer);
  passed = code === 0;
  if (!passed) process.exitCode = 1;
} finally {
  try {
    docker(["rm", "-f", name]);
  } catch {}
  try {
    docker(["volume", "rm", volume]);
  } catch {}
  await writeFile(
    join(evidence, "harness-result.json"),
    JSON.stringify(
      {
        passed,
        environment:
          "Linux control container + host network + local Linux Docker Engine; not an independent physical server",
        realModelRequests: 0,
      },
      null,
      2,
    ),
  );
}
