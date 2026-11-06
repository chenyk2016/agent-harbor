/**
 * 阶段A探针的宿主侧编排：按正式容器参数创建环境、挂载只读技能目录、运行探针并回收。
 * 用法：node tests/skill-probe.mjs <init|explicit|auto|boundary|namespaces|dynamic|slow>
 */
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenario = process.argv[2] ?? "init";
const image = "agent-harbor:0.4.0";
const stamp = new Date().toISOString().slice(0, 10);
const base = join(root, "var/evidence/skills-phase-a", stamp, scenario);
const container = `ah-probe-${scenario}-${process.pid}`;

const env = Object.fromEntries(
  (await readFile(join(root, ".env"), "utf8"))
    .split("\n")
    .filter(line => /^[A-Z_]+=/.test(line))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

await mkdir(join(base, "workspace"), { recursive: true });
await mkdir(join(base, "state"), { recursive: true });
await mkdir(join(base, "run"), { recursive: true });
await cp(join(root, "tests/skill-probe/agent.mjs"), join(base, "run/agent.mjs"));
await writeFile(join(base, "workspace/probe.csv"), "region,amount\nnorth,10\nsouth,25\n");

const scenarios = {
  init: { skills: "personal:table-summary", plugins: "personal", prompt: "" },
  explicit: { skills: "personal:table-summary", plugins: "personal", prompt: "/personal:table-summary summarize /workspace/probe.csv" },
  auto: { skills: "personal:table-summary", plugins: "personal", prompt: "Summarize /workspace/probe.csv" },
  boundary: {
    skills: "personal:table-summary", plugins: "personal",
    prompt: "Run this exact bash command and report its full stdout: set +e; head -c 40 /opt/harbor-skills/personal/skills/table-summary/SKILL.md; echo; echo probe > /opt/harbor-skills/personal/skills/table-summary/blocked.txt; echo write_skill=$?; echo probe > /workspace/probe-write.txt; echo write_workspace=$?",
  },
  namespaces: { skills: "personal:table-summary,builtin:table-summary", plugins: "personal,builtin", prompt: "/builtin:table-summary" },
  dynamic: { skills: "personal:dyn-probe", plugins: "personal", prompt: "" },
  "dynamic-run": { skills: "personal:dyn-probe", plugins: "personal", prompt: "/personal:dyn-probe" },
  "filter-deny": { skills: "personal:table-summary", plugins: "personal", prompt: "/personal:dyn-probe" },
  slow: { skills: "personal:slow-probe", plugins: "personal", prompt: "Use the slow-probe skill and run its script.", abortMs: "4000" },
  empty: { skills: "", plugins: "personal", prompt: "" },
  "none-name": { skills: "__none__", plugins: "personal", prompt: "" },
  "no-plugin": { skills: "", plugins: "", prompt: "" },
  "no-bundled": { skills: "", plugins: "personal", prompt: "", disableBundled: true },
};
const config = scenarios[scenario];
if (!config) throw new Error(`Unknown scenario ${scenario}`);

const create = [
  "create", "--name", container, "--init", "--interactive",
  "--label", "io.agent-harbor.project=agent-harbor",
  "--label", "harbor.probe=skills-phase-a",
  "--user", "1000:1000",
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--security-opt", `seccomp=${join(root, "infra/seccomp.json")}`,
  "--security-opt", "systempaths=unconfined",
  "--read-only",
  "--cpus", "2", "--memory", "4g", "--pids-limit", "256",
  "--tmpfs", "/tmp:rw,nosuid,size=256m,mode=1777",
  "--mount", `type=bind,src=${join(base, "workspace")},dst=/workspace`,
  "--mount", `type=bind,src=${join(base, "state")},dst=/platform/state`,
  "--mount", `type=bind,src=${join(base, "run")},dst=/platform/run,readonly`,
  "--mount", `type=bind,src=${join(root, "tests/fixtures/skill-probe")},dst=/opt/harbor-skills,readonly`,
  "--entrypoint", "node",
  "-e", `PROBE_SCENARIO=${scenario}`,
  "-e", `PROBE_SKILLS=${config.skills}`,
  "-e", `PROBE_PLUGINS=${config.plugins.split(",").filter(Boolean).map(name => `/opt/harbor-skills/${name}`).join(",")}`,
  "-e", `PROBE_PROMPT=${config.prompt}`,
  "-e", `PROBE_MODEL=${env.AH_MODEL}`,
  "-e", `PROBE_ABORT_MS=${config.abortMs ?? 0}`,
  ...(config.disableBundled ? ["-e", "PROBE_DISABLE_BUNDLED=1"] : []),
  "-e", `ANTHROPIC_BASE_URL=${env.AH_GATEWAY_URL}`,
  "-e", `ANTHROPIC_AUTH_TOKEN=${env.AH_GATEWAY_TOKEN}`,
  image,
  "/platform/run/agent.mjs",
];

execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
execFileSync("docker", create, { stdio: "inherit" });

const output = await new Promise((resolvePromise, reject) => {
  const child = spawn("docker", ["start", "--attach", container], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { stderr += chunk; process.stderr.write(chunk); });
  child.on("close", code => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`probe exited ${code}\n${stderr}`)));
});

const state = execFileSync("docker", ["inspect", "--format", "{{.State.ExitCode}}", container], { encoding: "utf8" }).trim();
const files = await readdir(join(base, "workspace"));
const blocked = existsSync(join(root, "tests/fixtures/skill-probe/personal/skills/table-summary/blocked.txt"));
const evidence = { scenario, container, exitCode: state, workspaceFiles: files, skillDirWritten: blocked, at: new Date().toISOString() };
await writeFile(join(base, "probe.json"), JSON.stringify(evidence, null, 2) + "\n");

execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
console.log("EVIDENCE " + JSON.stringify(evidence));
