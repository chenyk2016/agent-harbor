/** 应用数据账号密码静态加密；运行实例只取得自己的数据能力，主密钥从不进镜像。 */
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdir, readFile, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";

/** 使用实例私有主密钥加密数据账号密码；密文绑定环境身份，不能搬到另一应用冒充有效凭据。 */
export class ApplicationSecrets {
  private pending?: Promise<Buffer>;
  /** 指定主密钥所在私有目录；实际读取或创建推迟到第一次加解密时。 */
  constructor(readonly directory: string) {}
  /** 复用同一个主密钥加载 Promise，避免并发请求在本进程内重复初始化。 */
  private key() {
    return (this.pending ??= this.load());
  }
  /** 读取或原子创建 32 字节主密钥；并发创建采用链接竞争，最终读取胜出文件并校验长度。 */
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, ".application-data-key");
    let key: Buffer;
    try {
      key = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = target + "." + randomUUID();
      await writeFile(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
      try {
        await link(temporary, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        await rm(temporary, { force: true });
      }
      key = await readFile(target);
    }
    if (key.length !== 32) throw new Error("APPLICATION_DATA_KEY_INVALID");
    return key;
  }
  /** 使用 AES-256-GCM 和随机 IV 加密文本，并以 identity 作附加认证数据，返回可保存的 base64 密文。 */
  async seal(value: string, identity: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", await this.key(), iv);
    cipher.setAAD(Buffer.from(identity));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }
  /** 解析并验证绑定指定 identity 的认证密文；数据被改动或身份不一致时解密失败。 */
  async open(value: string, identity: string) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 29) throw new Error("APPLICATION_DATA_SECRET_INVALID");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      await this.key(),
      bytes.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(identity));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
}
