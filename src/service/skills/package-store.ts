/** 完整技能源包：所有路径由服务分配；版本按新目录发布，不原地覆盖。 */
import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import yauzl from "yauzl";
import yazl from "yazl";
import { fail } from "../types.js";
import {
  LIMITS,
  normalizePath,
  validateSkillPackage,
  type PackageFile,
  type PackageReport,
} from "./manifest.js";

export interface SourceFile {
  path: string;
  content: Buffer;
  mode?:number;
}
export interface CheckedPackage {
  files: SourceFile[];
  report: PackageReport;
}
export class PackageStore {
  constructor(readonly root: string) {}
  ownerKey(userId: string) {
    return createHash("sha256").update(userId).digest("hex").slice(0, 32);
  }
  /** 相对路径只在服务内生成，数据库不保存机器绝对地址。 */
  path(relative: string) {
    if (normalizePath(relative) !== relative)
      throw new Error("Invalid internal skill path");
    return join(resolve(this.root), relative);
  }
  skillPath(userId: string, skillId: string) {
    return `users/${this.ownerKey(userId)}/skills/${skillId}`;
  }
  /** 单实例服务串行发布同一用户的源包；按实际磁盘计费，包括旧草稿与失败残留。 */
  async sourceQuota(userId: string, files: SourceFile[]) {
    const base = `users/${this.ownerKey(userId)}`;
    const used =
      (await this.diskBytes(`${base}/skills`)) +
      (await this.diskBytes(`${base}/skill-imports`)) +
      (await this.diskBytes(`${base}/expert-packages`));
    if (
      used + files.reduce((sum, file) => sum + file.content.length, 0) >
      1024 ** 3
    )
      fail(413, "SKILL_STORAGE_LIMIT");
  }
  async diskBytes(relative: string): Promise<number> {
    const visit = async (path: string): Promise<number> => {
      const info = await lstat(path);
      if (info.isFile()) return info.size;
      if (!info.isDirectory()) return 0;
      let size = 0;
      for (const name of await readdir(path))
        size += await visit(join(path, name));
      return size;
    };
    try {
      return await visit(this.path(relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
  check(input: SourceFile[]): CheckedPackage {
    const candidates = input.filter(
      (file) =>
        file.path === "SKILL.md" || /^[^/]+\/SKILL\.md$/.test(file.path),
    );
    if (candidates.length !== 1) fail(400, "IMPORT_INVALID_LAYOUT");
    const prefix = candidates[0].path.slice(0, -"SKILL.md".length);
    if (input.some((file) => !file.path.startsWith(prefix)))
      fail(400, "IMPORT_INVALID_LAYOUT");
    const files = input.map((file) => ({
      ...file,
      path: file.path.slice(prefix.length),
    }));
    const metadata: PackageFile[] = files.map((file) => ({
      path: file.path,
      size: file.content.length,
      executable:Boolean(file.mode && (file.mode&0o111)),
      sha256: createHash("sha256").update(file.content).digest("hex"),
      text: isUtf8(file.content) ? file.content.toString("utf8") : undefined,
    }));
    const report = validateSkillPackage(metadata);
    return { files, report };
  }
  /** lazyEntries逐项读取并实际计数，不能只信ZIP头里的展开大小。 */
  async unzip(buffer: Buffer): Promise<CheckedPackage> {
    return this.check(await this.unzipFiles(buffer));
  }
  /** 通用ZIP读取；专家包可包含多份Agent和Skill，不走单Skill结构校验。 */
  async unzipFiles(buffer: Buffer): Promise<SourceFile[]> {
    if (buffer.length > 20 * 1024 * 1024) fail(413, "PACKAGE_LIMIT");
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
      yauzl.fromBuffer(
        buffer,
        { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
        (error, value) => (error ? reject(error) : resolve(value!)),
      ),
    );
    const files: SourceFile[] = [];
    let bytes = 0,
      entries = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = (error: unknown) => {
          zip.close();
          reject(error);
        };
        zip.on("error", stop);
        zip.on("end", resolve);
        zip.on("entry", (entry: yauzl.Entry) => {
          void (async () => {
            entries++;
            if (entries > LIMITS.maxFiles) fail(413, "PACKAGE_LIMIT");
            const path = entry.fileName.replace(/\/$/, "");
            if (!normalizePath(path) || entry.isEncrypted())
              fail(400, "INVALID_PACKAGE_PATH");
            const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (kind && kind !== 0o100000 && kind !== 0o040000)
              fail(400, "PACKAGE_LINK_NOT_ALLOWED");
            if (entry.fileName.endsWith("/")) {
              zip.readEntry();
              return;
            }
            if (entry.uncompressedSize > LIMITS.maxFileBytes)
              fail(413, "PACKAGE_LIMIT");
            const stream = await new Promise<NodeJS.ReadableStream>(
              (resolve, reject) =>
                zip.openReadStream(entry, (error, stream) =>
                  error ? reject(error) : resolve(stream!),
                ),
            );
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              size += chunk.length;
              bytes += chunk.length;
              if (size > LIMITS.maxFileBytes || bytes > LIMITS.maxTotalBytes)
                fail(413, "PACKAGE_LIMIT");
              chunks.push(Buffer.from(chunk));
            }
            files.push({
              path: normalizePath(path)!,
              content: Buffer.concat(chunks),
              mode: ((entry.externalFileAttributes>>>16)&0o111)?0o755:0o644,
            });
            zip.readEntry();
          })().catch(stop);
        });
        zip.readEntry();
      });
      return files;
    } finally {
      zip.close();
    }
  }
  async publish(relative: string, files: SourceFile[]) {
    const destination = this.path(relative),
      staging = destination + `.tmp-${randomUUID()}`;
    await mkdir(staging, { recursive: true, mode: 0o755 });
    try {
      for (const file of files) {
        if (normalizePath(file.path) !== file.path)
          fail(400, "INVALID_PACKAGE_PATH");
        const parts = file.path.split("/");
        parts.pop();
        await mkdir(join(staging, ...parts), { recursive: true, mode: 0o755 });
        await writeFile(join(staging, file.path), file.content, {
          mode: file.mode??0o644,
        });
      }
      // 文件先完整发布，后由调用方在事务中保存引用；失败只产生可清理的孤儿。
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async files(relative: string): Promise<SourceFile[]> {
    const root = this.path(relative),
      files: SourceFile[] = [];
    const visit = async (directory: string, prefix: string) => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name),
          stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          throw new Error("Unexpected skill file type");
        if (stat.isDirectory()) await visit(path, prefix + name + "/");
        else files.push({ path: prefix + name, content: await readFile(path),mode:stat.mode&0o111?0o755:0o644 });
      }
    };
    await visit(root, "");
    return files;
  }
  async export(relative: string): Promise<Buffer> {
    return this.pack(await this.files(relative));
  }
  async pack(files: SourceFile[]): Promise<Buffer> {
    const zip = new yazl.ZipFile(),
      chunks: Buffer[] = [];
    const output = new Promise<Buffer>((resolve, reject) => {
      zip.outputStream.on("data", (data) => chunks.push(data));
      zip.outputStream.on("error", reject);
      zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    });
    for (const file of files)
      zip.addBuffer(file.content, file.path,{mode:file.mode??0o644});
    zip.end();
    return output;
  }
}
