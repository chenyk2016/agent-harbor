/** Private single-writer transport for the isolated Runner profile. */
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { chmodSync, readFileSync, statSync } = require("node:fs");

const [runnerId, leaseId, mode] = process.argv.slice(2);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
if (!uuid.test(runnerId) || !uuid.test(leaseId) || (mode && !["mcp-probe", "app-analysis", "skill-build", "app-build"].includes(mode))) process.exit(2);
delete process.env.EXECD_ACCESS_TOKEN;
delete process.env.EXECD_ENVS;
const managerLease = process.env.HARBOR_MANAGER_LEASE;
delete process.env.HARBOR_MANAGER_LEASE;
function checkManager() {
  try {
    if (Date.now() - statSync(managerLease).mtimeMs <= 3000) return;
  } catch {}
  process.exit(1);
}
checkManager();
setInterval(checkManager, 500).unref();
const agent = "/platform/runtime/dist/src/agent/";
function checkOwner() {
  try {
    if (Date.now() - statSync(`/platform/run/.leases/${leaseId}`).mtimeMs <= 30000) return;
  } catch {}
  process.exit(1);
}
checkOwner();
setInterval(checkOwner, 5000).unref();

const path = "/platform/bridge/runner.sock";
const server = createServer({ allowHalfOpen: true }, socket => {
  // A failed connection ends this writer. Recovery must use a new environment.
  server.close();
  socket.on("error", () => process.exit(1));
  socket.on("close", () => process.exit(1));
  const attempt = `/platform/run/${runnerId}`;
  const args = mode === "app-analysis" ? ["/platform/runtime/app-analysis/runner.js"]
    : mode === "mcp-probe" ? [agent + "mcp-probe.js", attempt + "/connection.json"]
    : mode === "app-build" ? ["/platform/app-builder/launch.mjs"]
    : mode === "skill-build" ? [attempt + "/build.sh"]
    : [agent + "resident-runner.js", runnerId];
  let env = process.env;
  if (mode === "skill-build") env = { ...env, HOME: "/tmp", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  if (mode === "app-build") {
    env = { ...env, HOME: "/tmp", ...JSON.parse(readFileSync(attempt + "/build-env.json", "utf8")) };
  }
  const runner = spawn(mode === "skill-build" ? "/bin/sh" : process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env });
  runner.on("error", () => process.exit(1));
  runner.stdin.on("error", () => process.exit(1));
  socket.pipe(runner.stdin);
  async function frame(channel, bytes) {
    const header = Buffer.allocUnsafe(5);
    header[0] = channel;
    header.writeUInt32BE(bytes.length, 1);
    if (!socket.write(Buffer.concat([header, bytes]))) await once(socket, "drain");
  }
  async function forward(stream, channel) {
    for await (const chunk of stream) await frame(channel, chunk);
  }
  Promise.all([forward(runner.stdout, 1), forward(runner.stderr, 2), once(runner, "close")])
    .then(async ([, , [code]]) => {
      if (mode) await frame(3, Buffer.from([code ?? 1]));
      socket.end(() => process.exit(code ?? 1));
    })
    .catch(() => process.exit(1));
});
server.on("error", () => process.exit(1));
server.listen(path, () => chmodSync(path, 0o600));
