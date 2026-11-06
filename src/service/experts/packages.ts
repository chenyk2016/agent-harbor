/** 原包保真存储与运行派生物分开；Skill和专家在同一个数据库事务中发布。 */
import { sql } from "drizzle-orm";
import { expertVersions } from "../db/schema/index.js";
import { randomUUID } from "node:crypto";
import { readFile, rm, cp } from "node:fs/promises";
import type { ExpertService } from "./service.js";
import { parseWorkBuddy, localized } from "./workbuddy.js";
import type { ExpertDefinition } from "../../shared/experts.js";
import type { CheckedPackage } from "../skills/package-store.js";
import { fail } from "../types.js";
export interface PreparedExpertPackage {
  definition: ExpertDefinition;
  scope: string;
  skills: {
    id: string;
    versionId: string;
    sourcePath: string;
    checked: CheckedPackage;
  }[];
}
export async function importExpertPackage(
  service: ExpertService,
  user: string,
  requestId: string,
  archive: Buffer,
  expertId?: string,
  expectedVersionId?: string,
) {
  const store = service.library.packages;
  const parsed = parseWorkBuddy(await store.unzipFiles(archive), archive);
  const scope = randomUUID(),
    sourcePath = `users/${store.ownerKey(user)}/expert-packages/${scope}`;
  parsed.package.sourcePath = sourcePath;
  const items = parsed.skills.map((skill) => {
    const checked = store.check(skill.files);
    if (!checked.report.ok) fail(400, "INVALID_WORKBUDDY_SKILL");
    return {
      id: randomUUID(),
      versionId: randomUUID(),
      sourcePath: `${sourcePath}/derived/${skill.name}`,
      checked,
    };
  });
  const manifest = parsed.package.manifest;
  const input: PreparedExpertPackage = {
    scope,
    skills: items,
    definition: {
      name: localized(manifest.displayName, String(manifest.name)),
      description: localized(
        manifest.displayDescription,
        String(manifest.description ?? ""),
      ),
      role: parsed.package.agents[parsed.package.agentName].prompt,
      workflow: "",
      output: "",
      examples: Array.isArray(manifest.quickPrompts)
        ? manifest.quickPrompts.map((value) => localized(value)).filter(Boolean)
        : [],
      skillVersionIds: items.map((item) => item.versionId),
      workbuddy: parsed.package,
    },
  };
  const files = [
    { path: "original.zip", content: archive },
    ...parsed.files.map((file) => ({ ...file, path: `source/${file.path}` })),
    ...items.flatMap((item) =>
      item.checked.files.map((file) => ({
        ...file,
        path: `derived/${item.checked.report.manifest!.name}/${file.path}`,
      })),
    ),
  ];
  await store.sourceQuota(user, files);
  await store.publish(sourcePath, files);
  try {
    const result = await service.save(
      user,
      requestId,
      {},
      expertId,
      expectedVersionId,
      input,
    );
    // 重复请求可能返回原修订；未被采用的临时包不是正式版本。
    if (
      !result.versions.some(
        (version) => version.definition.workbuddy?.sourcePath === sourcePath,
      )
    )
      await rm(store.path(sourcePath), { recursive: true, force: true });
    return result;
  } catch (error) {
    // COMMIT回执丢失时不能删除可能已被引用的原件；查询也失败则保留待协调。
    let referenced = true;
    try {
      const rows = await service.library.db
        .select({ id: expertVersions.id })
        .from(expertVersions)
        .where(
          sql`${expertVersions.definition}->'workbuddy'->>'sourcePath' = ${sourcePath}`,
        )
        .limit(1);
      referenced = rows.length > 0;
    } catch {}
    if (!referenced)
      await rm(store.path(sourcePath), { recursive: true, force: true });
    throw error;
  }
}
export async function originalExpertArchive(
  service: ExpertService,
  user: string,
  versionId: string,
) {
  const { version } = await service.version(user, versionId);
  const source = version.definition.workbuddy?.sourcePath;
  if (!source) fail(404, "EXPERT_PACKAGE_NOT_FOUND");
  return readFile(service.library.packages.path(`${source}/original.zip`));
}

export async function expertPackageFiles(
  service: ExpertService,
  user: string,
  versionId: string,
) {
  const { version } = await service.version(user, versionId);
  const location = version.definition.workbuddy?.sourcePath;
  if (!location) fail(404, "EXPERT_PACKAGE_NOT_FOUND");
  return service.library.packages.files(`${location}/source`);
}
export async function editExpertPackage(
  service: ExpertService,
  user: string,
  id: string,
  versionId: string,
  requestId: string,
  changes: { path: string; text: string | null }[],
) {
  await service.owned(user, id, true);
  const original = await service.version(user, versionId);
  if (original.expert.id !== id) fail(404, "EXPERT_NOT_FOUND");
  const files = new Map(
    (await expertPackageFiles(service, user, versionId)).map((file) => [
      file.path,
      file.content,
    ]),
  );
  for (const change of changes) {
    if (change.text === null) files.delete(change.path);
    else files.set(change.path, Buffer.from(change.text));
  }
  const prefix = original.version.definition.workbuddy!.rootPrefix;
  const archive = await service.library.packages.pack(
    [...files].map(([path, content]) => ({ path: prefix + path, content })),
  );
  return importExpertPackage(service, user, requestId, archive, id, versionId);
}
export async function createExpertPackage(
  service: ExpertService,
  user: string,
  requestId: string,
  input: { name: string; description: string; instructions: string },
) {
  if (
    !input.name ||
    !input.instructions ||
    input.name.length > 200 ||
    input.instructions.length > 100000
  )
    fail(400, "INVALID_EXPERT");
  const packageName = `personal-expert-${randomUUID().slice(0, 8)}`;
  const manifest = {
    name: packageName,
    plugin: packageName,
    version: "1.0.0",
    expertType: "agent",
    agentName: "expert",
    agents: ["./agents/expert.md"],
    description: input.description,
    displayName: { zh: input.name },
    displayDescription: { zh: input.description },
    author: { name: user },
    quickPrompts: [],
  };
  const files = [
    {
      path: ".codebuddy-plugin/plugin.json",
      content: Buffer.from(JSON.stringify(manifest, null, 2)),
    },
    {
      path: "agents/expert.md",
      content: Buffer.from(
        `---\nname: expert\ndescription: Personal expert\n---\n${input.instructions}`,
      ),
    },
  ];
  return importExpertPackage(
    service,
    user,
    requestId,
    await service.library.packages.pack(files),
  );
}

export async function bundleExpertSource(
  service: ExpertService,
  user: string,
  versionId: string,
  sessionId: string,
  capabilityDigest: string,
) {
  const { version } = await service.version(user, versionId),
    bundle = version.definition.workbuddy;
  if (!bundle) return;
  const target = service.library.packages.path(
    `${sessionId}/capabilities/${capabilityDigest}/workbuddy-source`,
  );
  await cp(
    service.library.packages.path(`${bundle.sourcePath}/source`),
    target,
    { recursive: true },
  );
}
