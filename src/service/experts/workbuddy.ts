/** 读取WorkBuddy原生格式；不重写正文，不把市场上架文案规范当运行门槛。 */
import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { basename, posix } from "node:path";
import type { SourceFile } from "../skills/package-store.js";
import { normalizePath } from "../skills/manifest.js";
import { fail } from "../types.js";
import type { WorkBuddyPackage, WorkBuddyAgent } from "../../shared/experts.js";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "INVALID_WORKBUDDY_PACKAGE");
  return value as Record<string, unknown>;
};
export function localized(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return typeof item.zh === "string"
      ? item.zh
      : typeof item.en === "string"
        ? item.en
        : fallback;
  }
  return fallback;
}
const strings = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    fail(400, "INVALID_WORKBUDDY_PACKAGE");
  return value as string[];
};
function path(value: string) {
  const clean = normalizePath(value);
  if (!clean) fail(400, "INVALID_PACKAGE_PATH");
  return clean;
}
export function frontmatter(text: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) fail(400, "WORKBUDDY_FRONTMATTER_REQUIRED");
  const parsed = parseDocument(match[1], { uniqueKeys: true });
  if (parsed.errors.length) fail(400, "INVALID_WORKBUDDY_YAML");
  return {
    metadata: object(parsed.toJS({ maxAliasCount: 0 })),
    body: text.slice(match[0].length),
  };
}
export interface ParsedWorkBuddy {
  files: SourceFile[];
  package: WorkBuddyPackage;
  skills: { path: string; name: string; files: SourceFile[] }[];
}
export function parseWorkBuddy(
  input: SourceFile[],
  archive: Buffer,
): ParsedWorkBuddy {
  // Apple打包旁车不参与根目录发现；原ZIP仍完整保存。
  const useful = input.filter(
    (file) =>
      !file.path
        .split("/")
        .some(
          (part) =>
            part === "__MACOSX" ||
            part === ".DS_Store" ||
            part.startsWith("._"),
        ),
  );
  const candidates = useful.filter((file) =>
    /(^|\/)\.codebuddy-plugin\/plugin\.json$/.test(file.path),
  );
  if (candidates.length !== 1) fail(400, "WORKBUDDY_ROOT_REQUIRED");
  const rootPrefix = candidates[0].path.slice(
    0,
    -".codebuddy-plugin/plugin.json".length,
  );
  if (useful.some((file) => !file.path.startsWith(rootPrefix)))
    fail(400, "WORKBUDDY_MULTIPLE_ROOTS");
  const files = useful.map((file) => ({
    ...file,
    path: file.path.slice(rootPrefix.length),
  }));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    fail(400, "DUPLICATE_PACKAGE_PATH");
  const read = (name: string) => {
    const file = files.find((file) => file.path === path(name));
    if (!file) fail(400, "WORKBUDDY_FILE_MISSING");
    return file.content.toString("utf8");
  };
  let manifest: Record<string, unknown>;
  try {
    manifest = object(JSON.parse(read(".codebuddy-plugin/plugin.json")));
  } catch {
    fail(400, "INVALID_WORKBUDDY_MANIFEST");
  }
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.agentName !== "string"
  )
    fail(400, "INVALID_WORKBUDDY_MANIFEST");
  const expertType = manifest.expertType;
  if (expertType !== "agent" && expertType !== "team")
    fail(400, "INVALID_WORKBUDDY_TYPE");
  const agents: Record<string, WorkBuddyAgent> = Object.create(null),
    warnings: string[] = [];
  for (const entry of strings(manifest.agents)) {
    const location = path(entry),
      { metadata, body } = frontmatter(read(location));
    const name = metadata.name;
    if (
      typeof name !== "string" ||
      name !== basename(location, ".md") ||
      agents[name]
    )
      fail(400, "INVALID_WORKBUDDY_AGENT");
    const maxTurns = metadata.maxTurns;
    if (
      maxTurns !== undefined &&
      (!Number.isSafeInteger(maxTurns) || Number(maxTurns) < 1)
    )
      fail(400, "INVALID_WORKBUDDY_AGENT");
    agents[name] = {
      name,
      description: localized(metadata.description, name),
      prompt: body,
      skills: strings(metadata.skills),
      ...(maxTurns === undefined ? {} : { maxTurns: Number(maxTurns) }),
    };
    if (metadata.tools)
      warnings.push(`${name}: tools由运行平台分配，原字段保留在源文件中。`);
  }
  if (expertType === "team") {
    const team = object(manifest.teamInfo);
    if (
      team.leadAgent !== manifest.agentName ||
      strings(team.memberAgents).some((name) => !agents[name])
    )
      fail(400, "INVALID_WORKBUDDY_TEAM");
  }
  if (!agents[manifest.agentName]) fail(400, "WORKBUDDY_MAIN_AGENT_MISSING");
  if (
    typeof manifest.avatar === "string" &&
    !files.some((file) => file.path === path(String(manifest.avatar)))
  )
    warnings.push("包中缺少配置的头像，使用默认头像。");
  const declared = strings(manifest.skills).map(path);
  const discovered = files
    .filter((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.path))
    .map((file) => posix.dirname(file.path));
  const skillPaths = [...new Set([...declared, ...discovered])];
  const skillNames = new Set<string>();
  const skills = skillPaths.map((location) => {
    const prefix = location + "/";
    const original = files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
    const md = original.find((file) => file.path === "SKILL.md");
    if (!md) fail(400, "WORKBUDDY_SKILL_MISSING");
    const { metadata, body } = frontmatter(md.content.toString("utf8"));
    const name =
      typeof metadata.name === "string" ? metadata.name : basename(location);
    if (skillNames.has(name)) fail(400, "WORKBUDDY_SKILL_NAME_CONFLICT");
    skillNames.add(name);
    // 旧Skill头只在派生物补齐Claude字段，原始文件与ZIP不变。
    const description =
      typeof metadata.description === "string"
        ? metadata.description
        : localized(metadata.summary, localized(metadata.title, name));
    const normalized = Buffer.from(
      `---\n${stringify({ ...metadata, name, description })}---\n${body}`,
    );
    return {
      path: location,
      name,
      files: original.map((file) =>
        file.path === "SKILL.md" ? { ...file, content: normalized } : file,
      ),
    };
  });
  for (const agent of Object.values(agents)) {
    for (const name of agent.skills)
      if (!skillNames.has(name))
        warnings.push(
          `${agent.name}: 预加载技能 ${name} 不在包内，需要解析已安装能力。`,
        );
  }
  const dependencies =
    manifest.dependencies === undefined ? {} : object(manifest.dependencies);
  const configFiles =
    dependencies.mcpServers === undefined
      ? files.some((file) => file.path === ".mcp.json")
        ? [".mcp.json"]
        : []
      : typeof dependencies.mcpServers === "string"
        ? [dependencies.mcpServers]
        : strings(dependencies.mcpServers);
  const mcpServers: Record<string, Record<string, unknown>> = Object.create(
    null,
  );
  for (const configFile of configFiles) {
    let config: Record<string, unknown>;
    try {
      config = object(JSON.parse(read(path(configFile))));
    } catch {
      fail(400, "INVALID_WORKBUDDY_MCP");
    }
    for (const [name, value] of Object.entries(object(config.mcpServers))) {
      if (mcpServers[name]) fail(400, "DUPLICATE_WORKBUDDY_MCP");
      mcpServers[name] = object(value);
    }
  }
  return {
    files,
    skills,
    package: {
      sourcePath: "",
      archiveHash: createHash("sha256").update(archive).digest("hex"),
      rootPrefix,
      manifest,
      agents,
      agentName: manifest.agentName,
      expertType,
      skillPaths,
      mcpServers,
      connectors: strings(dependencies.connectors),
      warnings,
    },
  };
}
