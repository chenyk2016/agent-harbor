/** 显式生成开发访问密钥；明文只输出这一次，磁盘保存哈希。 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tokenHash, Auth } from "./auth.js";
import { lockSession } from "../runtime/storage.js";
const userId = process.argv[2];
if (!userId || !/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) throw new Error("Usage: npm run access-key -- USER_ID (service must be stopped)");
const directory = resolve(process.env.AH_DATA_DIR ?? "var/service-sessions", ".service");
await mkdir(directory, { recursive: true, mode: 0o700 });
const release = await lockSession(directory);
try {
  const path = join(directory, "access-keys.json");
  let keys: { userId: string; tokenHash: string }[] = [];
  try { keys = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const token = randomBytes(32).toString("base64url");
  keys.push({ userId, tokenHash: tokenHash(token) });
  new Auth(keys);
  await writeFile(`${path}.tmp`, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  console.log(token);
} finally { await release(); }
