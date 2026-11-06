/** 主密钥只在宿主服务目录；避免明文凭据进入快照、配置与诊断。 */
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import { mkdir, readFile, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";
export class McpSecrets {
  private keyPromise?: Promise<Buffer>;
  constructor(private root: string) {}
  private key() {
    return (this.keyPromise ??= this.load());
  }
  private async load() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, ".mcp-key");
    try {
      return await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const tmp = file + "." + randomUUID();
    await writeFile(tmp, randomBytes(32), { mode: 0o600 });
    try {
      await link(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await rm(tmp, { force: true });
    }
    return readFile(file);
  }
  async seal(value: Record<string, string>) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", await this.key(), iv);
    const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
  }
  async open(value: string): Promise<Record<string, string>> {
    const data = Buffer.from(value, "base64"),
      d = createDecipheriv(
        "aes-256-gcm",
        await this.key(),
        data.subarray(0, 12),
      );
    d.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([d.update(data.subarray(28)), d.final()]).toString(),
    );
  }
}
/** 最小防回显：不能代替对持钥MCP程序的信任。 */
export function redact<T>(value: T, secrets: Record<string, string>): T {
  const parts = Object.values(secrets)
    .flatMap((raw) => [raw, raw.replace(/^Bearer\s+/i, "")])
    .filter((p) => p.length >= 4);
  function visit(item: unknown): unknown {
    if (typeof item === "string") {
      for (const part of parts)
        item = (item as string).split(part).join("[REDACTED]");
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([k, v]) => [k, visit(v)]),
      );
    return item;
  }
  return visit(value) as T;
}
