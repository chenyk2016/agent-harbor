/** Private single-writer transport for the isolated Runner profile. */
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { once } = require("node:events");
const { chmodSync } = require("node:fs");

const [runnerId, leaseId] = process.argv.slice(2);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
if (!uuid.test(runnerId) || !uuid.test(leaseId)) process.exit(2);
delete process.env.EXECD_ACCESS_TOKEN;
delete process.env.EXECD_ENVS;
const agent = "/platform/runtime/dist/src/agent/";
const keeper = spawn(process.execPath, [agent + "keeper.js", leaseId], { stdio: "inherit" });
keeper.on("error", () => process.exit(1));
keeper.on("exit", code => process.exit(code ?? 1));

const path = "/platform/bridge/runner.sock";
const server = createServer({ allowHalfOpen: true }, socket => {
  // A failed connection ends this writer. Recovery must use a new environment.
  server.close();
  socket.on("error", () => process.exit(1));
  socket.on("close", () => process.exit(1));
  const runner = spawn(process.execPath, [agent + "resident-runner.js", runnerId], { stdio: ["pipe", "pipe", "pipe"] });
  runner.on("error", () => process.exit(1));
  runner.stdin.on("error", () => process.exit(1));
  socket.pipe(runner.stdin);
  async function forward(stream, channel) {
    for await (const chunk of stream) {
      const header = Buffer.allocUnsafe(5);
      header[0] = channel;
      header.writeUInt32BE(chunk.length, 1);
      if (!socket.write(Buffer.concat([header, chunk]))) await once(socket, "drain");
    }
  }
  Promise.all([forward(runner.stdout, 1), forward(runner.stderr, 2), once(runner, "close")])
    .then(([, , [code]]) => socket.end(() => process.exit(code ?? 1)))
    .catch(() => process.exit(1));
});
server.on("error", () => process.exit(1));
server.listen(path, () => chmodSync(path, 0o600));
