/** Trusted entry, outside the tool sandbox. Reads platform material, then starts ONLY srt with a clean environment. */
import { readFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { LocalMcpLaunch } from "../shared/mcp.js";
const file = process.argv[2];
if (!file || !/^\/platform\/run\/[a-f0-9-]+\/mcp-[a-f0-9-]+\.json$/.test(file))
  throw new Error("MCP_STARTUP_PATH_INVALID");
const launch = JSON.parse(await readFile(file, "utf8")) as LocalMcpLaunch;
if (!/^[a-f0-9-]{36}$/.test(launch.id))
  throw new Error("MCP_STARTUP_ID_INVALID");
const base = "/session-env/mcp/" + launch.id,
  home = join(base, "home");
await mkdir(home, { recursive: true });
const env: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  npm_config_cache: "/dependency-cache/npm",
  UV_CACHE_DIR: "/dependency-cache/uv",
  PIP_CACHE_DIR: "/dependency-cache/pip",
  UV_LINK_MODE: "copy",
  UV_PYTHON_DOWNLOADS: "never",
  ...launch.env,
};
const srt =
  "/opt/harbor-runtime/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js";
const settings = join(file, "..", "mcp-sandbox.json");
let child: ReturnType<typeof spawn> | undefined,
  stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
async function run(command: string[], install = false) {
  if (stopping) throw new Error("MCP_CANCELLED");
  await new Promise<void>((ok, bad) => {
    child = spawn(
      "/usr/local/bin/node",
      [srt, "--settings", settings, ...command],
      {
        env,
        cwd: launch.script ? join(base, "app") : "/workspace",
        stdio: install
          ? ["ignore", "ignore", "ignore"]
          : ["inherit", "inherit", "ignore"],
      },
    );
    child.once("error", () => bad(new Error("MCP_SANDBOX_START_FAILED")));
    child.once("exit", (code) =>
      code === 0
        ? ok()
        : bad(
            new Error(
              install ? "MCP_DEPENDENCY_PREPARE_FAILED" : "MCP_PROCESS_FAILED",
            ),
          ),
    );
  });
}
try {
  if (launch.script) {
    const app = join(base, "app"),
      script = launch.script;
    if (!resolve(app, script.entry).startsWith(app + "/"))
      throw new Error("MCP_SCRIPT_ENTRY_INVALID");
    if (script.install === "npm")
      await run(
        [
          "/usr/local/bin/npm",
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        true,
      );
    if (script.install === "uv")
      await run(["/usr/local/bin/uv", "venv", join(base, "venv")], true);
    if (script.install === "uv")
      await run(
        [
          "/usr/local/bin/uv",
          "pip",
          "install",
          "--python",
          join(base, "venv/bin/python"),
          "-r",
          join(app, "requirements.txt"),
        ],
        true,
      );
    await run([
      script.runtime === "node"
        ? "/usr/local/bin/node"
        : script.install === "uv"
          ? join(base, "venv/bin/python")
          : "/usr/bin/python3",
      join(app, script.entry),
    ]);
  } else await run(launch.command);
} catch {
  process.stderr.write(
    "MCP_LAUNCH_FAILED: check template, sandbox and dependency configuration\n",
  );
  process.exitCode = 1;
}
