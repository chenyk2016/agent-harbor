/** 独立浏览器验收：合成账号/资料、本地模型，实际Docker/SDK，不读取私有.env。 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tokenHash } from "../dist/src/service/auth.js";
import { fixtureModel } from "../dist/tests/fixture-model.js";
const root = resolve("var/react-web-preview");
const evidence = resolve(process.env.AH_EVIDENCE_DIR ?? "var/evidence/react-preview");
await mkdir(join(root, ".service"), { recursive: true, mode: 0o700 });
await mkdir(evidence, { recursive: true });
await writeFile(
  join(root, ".service/access-keys.json"),
  JSON.stringify([
    { userId: "react-test-a", tokenHash: tokenHash("react-fixture-a") },
    { userId: "react-test-b", tokenHash: tokenHash("react-fixture-b") },
  ]),
  { mode: 0o600 },
);
const model = fixtureModel([
  {
    name: "Bash",
    input: {
      command:
        'mkdir -p /workspace/outputs; echo "React UI file result" > /workspace/outputs/result.txt; sleep 8',
      timeout: 20000,
    },
  },
]);
await new Promise((done) => model.server.listen(0, "0.0.0.0", done));
const child = spawn(process.execPath, ["dist/src/service/server.js"], {
  env: {
    ...process.env,
    AH_DATA_DIR: root,
    AH_GATEWAY_TOKEN: "FIXTURE_ONLY",
    AH_SERVICE_PORT: "8436",
    AH_GATEWAY_URL: `http://host.docker.internal:${model.server.address().port}`,
    AH_IMAGE: "agent-harbor:0.4.0",
    AH_ADMIN_USERS: "react-test-a",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => {
  output += data;
  process.stdout.write(data);
});
child.stderr.on("data", (data) => {
  output += data;
  process.stderr.write(data);
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill("SIGTERM"));
child.once("exit", async (code) => {
  model.server.closeAllConnections();
  model.server.close();
  await writeFile(join(evidence, "preview.log"), output);
  await writeFile(
    join(evidence, "preview-model.json"),
    JSON.stringify({
      fixtureRequests: model.requests.length,
      realModelRequests: 0,
    }),
  );
  process.exitCode = code ?? 1;
});
