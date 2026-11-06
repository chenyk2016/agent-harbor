/**
 * Skill 源包的文件格式解析：不碰文件系统、不依赖数据库，便于单测与后续导入复用。
 * 只读取展示/存储所需的元数据，正文和原生扩展字段交给Claude解释。
 */
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

export const LIMITS = {
  maxFiles: 1000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxPathLength: 200,
  maxDescription: 1024,
  maxName: 64,
} as const;

export interface PackageFile {
  /** 包内相对路径，使用 / 分隔。 */
  path: string;
  size: number;
  /** 文本内容；二进制文件可不提供，只做路径与大小校验。 */
  text?: string;
  kind?: "file" | "symlink";
  sha256?: string;
  executable?:boolean;
}

export interface Issue {
  code: string;
  path?: string;
  message: string;
}

export interface SkillManifest {
  name: string;
  description: string;
  allowedTools: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  argumentHint?: string;
  license?: string;
  /** 去掉 frontmatter 后的正文。 */
  body: string;
  /** 包内实际相对路径（已归一化）。 */
  files: string[];
  sizeBytes: number;
  /** 可选平台扩展；没有它说明这是纯说明技能。 */
  harbor?: HarborExtension;
}

export interface HarborExtension {
  schemaVersion: 1;
  runtimeProfileId?: "standard";
  dependencies?: {
    python?: { lockFile: string; binaryOnly: true };
    node?: { manifest: string; lockFile: string; lifecycleScripts: "disabled" };
  };
  entrypoints?: { name: string; language: "python" | "node"; script: string }[];
}

export interface PackageReport {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  manifest?: SkillManifest;
  digest?: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 归一化包内路径；非法路径返回 null，由调用方记错误。 */
export function normalizePath(raw: string): string | null {
  if (!raw || raw.length > LIMITS.maxPathLength) return null;
  if (raw.includes("\\") || raw.includes("\0") || /^[a-z]:/i.test(raw))
    return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  const path = raw.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (path.startsWith("/")) return null;
  const segments = path.split("/").filter(Boolean);
  if (!segments.length || segments.length > 16) return null;
  if (segments.some((segment) => segment === ".." || segment === "."))
    return null;
  return segments.join("/").normalize("NFC");
}

function parseFrontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
  error?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match)
    return {
      data: {},
      body: text,
      error: "SKILL.md需要完整的YAML frontmatter",
    };
  try {
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length || document.warnings.length)
      throw new Error("YAML格式或标签不支持");
    const data = document.toJS({ maxAliasCount: 0 });
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("配置必须是键值对象");
    return { data, body: text.slice(match[0].length) };
  } catch (error) {
    return {
      data: {},
      body: "",
      error: error instanceof Error ? error.message : "配置无法解析",
    };
  }
}

function findSkillFile(
  files: PackageFile[],
): { path: string; prefix: string } | { error: string } {
  const candidates = files.filter(
    (file) => file.path === "SKILL.md" || /^[^/]+\/SKILL\.md$/.test(file.path),
  );
  if (!candidates.length)
    return { error: "包内没有 SKILL.md（根目录或单层子目录）" };
  if (candidates.length > 1)
    return {
      error: `包内有多份 SKILL.md：${candidates.map((file) => file.path).join(", ")}`,
    };
  const path = candidates[0].path;
  return {
    path,
    prefix: path === "SKILL.md" ? "" : path.slice(0, -"SKILL.md".length),
  };
}

/** 校验整包并给出可发布清单；错误非空时不得发布。 */
export function validateSkillPackage(
  input: PackageFile[],
  options: { harbor?: string } = {},
): PackageReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const seen = new Set<string>();
  let total = 0;

  if (input.length > LIMITS.maxFiles)
    errors.push({
      code: "TOO_MANY_FILES",
      message: `文件数超过 ${LIMITS.maxFiles}`,
    });

  const files: PackageFile[] = [];
  for (const raw of input) {
    const path = normalizePath(raw.path);
    if (!path) {
      errors.push({
        code: "INVALID_PATH",
        path: raw.path,
        message: "路径非法（绝对路径、..、反斜杠或控制字符）",
      });
      continue;
    }
    const lower = path.toLowerCase();
    if (seen.has(lower)) {
      errors.push({
        code: "DUPLICATE_PATH",
        path,
        message: "同一路径大小写重复",
      });
      continue;
    }
    seen.add(lower);
    if (raw.kind === "symlink") {
      errors.push({
        code: "SYMLINK_NOT_ALLOWED",
        path,
        message: "不接受符号链接",
      });
      continue;
    }
    if (!Number.isSafeInteger(raw.size) || raw.size < 0) {
      errors.push({ code: "INVALID_SIZE", path, message: "文件大小无效" });
      continue;
    }
    if (raw.size > LIMITS.maxFileBytes)
      errors.push({
        code: "FILE_TOO_LARGE",
        path,
        message: `单文件超过 ${LIMITS.maxFileBytes} 字节`,
      });
    total += raw.size;
    files.push({ ...raw, path });
  }
  if (total > LIMITS.maxTotalBytes)
    errors.push({
      code: "PACKAGE_TOO_LARGE",
      message: `总大小超过 ${LIMITS.maxTotalBytes} 字节`,
    });

  const found = findSkillFile(files);
  if ("error" in found) {
    errors.push({ code: "SKILL_MD_MISSING", message: found.error });
    return { ok: false, errors, warnings };
  }

  const skillFile = files.find((file) => file.path === found.path)!;
  const parsed = parseFrontmatter(skillFile.text ?? "");
  if (parsed.error)
    errors.push({
      code: "FRONTMATTER_INVALID",
      path: skillFile.path,
      message: parsed.error,
    });
  const name = typeof parsed.data.name === "string" ? parsed.data.name : "";
  const description =
    typeof parsed.data.description === "string" ? parsed.data.description : "";
  if (!NAME_PATTERN.test(name))
    errors.push({
      code: "NAME_INVALID",
      path: skillFile.path,
      message: "name 必须是 1–64 位小写字母、数字或连字符，且以字母或数字开头",
    });
  if (!description.trim() || description.length > LIMITS.maxDescription)
    errors.push({
      code: "DESCRIPTION_INVALID",
      path: skillFile.path,
      message: `description 必填且不超过 ${LIMITS.maxDescription} 字符`,
    });
  const allowedTools =
    typeof parsed.data["allowed-tools"] === "string"
      ? parsed.data["allowed-tools"]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  const userInvocable = parsed.data["user-invocable"] !== false;

  let harbor: HarborExtension | undefined;
  const harborFile = files.find(
    (file) => file.path === `${found.prefix}harbor-skill.json`,
  );
  const harborText = harborFile?.text ?? options.harbor;
  if (harborText) {
    try {
      const value = JSON.parse(harborText) as HarborExtension;
      if (!value || value.schemaVersion !== 1)
        throw new Error("只支持schemaVersion 1");
      for (const key of Object.keys(value))
        if (
          ![
            "schemaVersion",
            "runtimeProfileId",
            "dependencies",
            "entrypoints",
          ].includes(key)
        )
          throw new Error(`未知配置：${key}`);
      if (value.runtimeProfileId && value.runtimeProfileId !== "standard")
        throw new Error("运行档位不可用");
      const localFile = (path: string) =>
        typeof path === "string" &&
        normalizePath(path) === path &&
        files.some((file) => file.path === found.prefix + path);
      if (
        value.dependencies !== undefined &&
        (!value.dependencies ||
          typeof value.dependencies !== "object" ||
          Array.isArray(value.dependencies))
      )
        throw new Error("dependencies必须是对象");
      for (const [kind, config] of Object.entries(value.dependencies ?? {})) {
        if (!config || typeof config !== "object" || Array.isArray(config))
          throw new Error("依赖需要锁文件声明，不能使用包名数组");
        if (kind === "python") {
          const py = config as NonNullable<
            NonNullable<HarborExtension["dependencies"]>["python"]
          >;
          if (
            py.binaryOnly !== true ||
            !localFile(py.lockFile) ||
            Object.keys(py).some((k) => !["lockFile", "binaryOnly"].includes(k))
          )
            throw new Error("Python需要包内wheel锁文件与binaryOnly=true");
        } else if (kind === "node") {
          const node = config as NonNullable<
            NonNullable<HarborExtension["dependencies"]>["node"]
          >;
          if (
            node.lifecycleScripts !== "disabled" ||
            node.manifest !== "package.json" ||
            node.lockFile !== "package-lock.json" ||
            !localFile(node.manifest) ||
            !localFile(node.lockFile) ||
            Object.keys(node).some(
              (k) => !["manifest", "lockFile", "lifecycleScripts"].includes(k),
            )
          )
            throw new Error("Node需要manifest/锁文件并禁用安装脚本");
        } else throw new Error(`不支持依赖类型：${kind}`);
      }
      if (value.entrypoints !== undefined && !Array.isArray(value.entrypoints))
        throw new Error("entrypoints必须是数组");
      const names = new Set<string>();
      for (const entry of value.entrypoints ?? []) {
        if (
          !entry ||
          !NAME_PATTERN.test(entry.name) ||
          names.has(entry.name) ||
          !["python", "node"].includes(entry.language) ||
          !localFile(entry.script)
        )
          throw new Error("运行入口名称、语言或脚本路径无效");
        names.add(entry.name);
      }
      harbor = value;
    } catch (error) {
      errors.push({
        code: "HARBOR_JSON_INVALID",
        path: harborFile?.path,
        message: `harbor-skill.json 无效：${String(error).slice(0, 120)}`,
      });
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  return {
    ok: true,
    errors,
    warnings,
    manifest: {
      name,
      description,
      allowedTools,
      userInvocable,
      license:
        typeof parsed.data.license === "string"
          ? parsed.data.license
          : undefined,
      disableModelInvocation: parsed.data["disable-model-invocation"] === true,
      argumentHint:
        typeof parsed.data["argument-hint"] === "string"
          ? parsed.data["argument-hint"]
          : undefined,
      body: parsed.body.trim(),
      files: files.map((file) => file.path).sort(),
      sizeBytes: total,
      harbor,
    },
    digest: packageDigest(files),
  };
}

/** 内容摘要：路径、大小与文本内容共同决定，用于判断"同一份包"。 */
export function packageDigest(files: PackageFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update("\0").update(String(file.size)).update("\0");
    if(file.executable)hash.update("executable\0");
    if (file.sha256) hash.update(file.sha256);
    else if (file.text !== undefined) hash.update(file.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}
