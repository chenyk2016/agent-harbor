/** 开发身份：磁盘仅保存token哈希；身份从凭证取得，不相信请求中的userId。 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fail } from "./types.js";
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export class Auth {
  constructor(readonly keys: { userId: string; tokenHash: string }[]) {
    if (keys.some(key => !key.userId || !/^[a-f0-9]{64}$/.test(key.tokenHash))) throw new Error("Invalid access keys configuration");
    if (new Set(keys.map(key => key.tokenHash)).size !== keys.length) throw new Error("Duplicate access key");
  }
  static async load(path: string) { return new Auth(JSON.parse(await readFile(path, "utf8"))); }
  user(authorization?: string) {
    const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
    const key = token && this.keys.find(key => key.tokenHash === tokenHash(token));
    if (!key) fail(401, "UNAUTHORIZED");
    return key.userId;
  }
}
