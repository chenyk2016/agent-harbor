/** One-way runtime cleanup only. Old DB bindings/audit remain intact for backup and rollback. */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function recoverLegacyWorkers(root: string) {
  const directory = join(root, "mcp-workers"),
    owner = createHash("sha256").update(root).digest("hex").slice(0, 20);
  const files = await readdir(directory).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
    const path = join(directory, file),
      r = JSON.parse(await readFile(path, "utf8"));
    if (r.name !== "ah-mcp-" + r.bindingId || file !== r.bindingId + ".json")
      throw new Error("MCP_LEGACY_RECORD_INVALID");
    const command = async (args: string[]) =>
      (await exec("docker", args, { timeout: 20000 })).stdout.trim();
    try {
      if (await command(["ps", "-aq", "--filter", "name=^/" + r.name + "$"])) {
        const [state] = JSON.parse(await command(["inspect", r.name]));
        const labels = state.Config.Labels ?? {};
        if (
          labels["harbor.mcp.owner"] !== owner ||
          labels["harbor.mcp.binding"] !== r.bindingId ||
          labels["harbor.mcp.epoch"] !== r.epoch ||
          state.Image !== r.image
        )
          throw new Error("MCP_LEGACY_OWNER_MISMATCH");
        await command(["rm", "--force", r.name]);
        if (await command(["ps", "-aq", "--filter", "name=^/" + r.name + "$"]))
          throw new Error("MCP_LEGACY_STOP_UNCONFIRMED");
      }
      await writeFile(path, JSON.stringify({ ...r, state: "stopped" }), {
        mode: 0o600,
      });
    } catch {
      await writeFile(path, JSON.stringify({ ...r, state: "reconciling" }), {
        mode: 0o600,
      });
      throw new Error("MCP_LEGACY_STOP_UNCONFIRMED");
    }
  }
}
