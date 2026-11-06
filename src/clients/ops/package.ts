/** 发布包使用白名单和内容清单；公开发行保留既有全历史审计，不暗中绕过。 */
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { inventory } from "./backup.js";
import {
  run,
  privateJson,
  requireThat,
  emptyDirectory,
  projectRoot,
} from "./common.js";
export async function packageRelease(
  destination: string,
  image: string,
  localOnly = false,
) {
  const output = resolve(destination);
  requireThat(
    !output.startsWith(join(projectRoot, "dist") + sep),
    "PACKAGE_OUTSIDE_DIST_REQUIRED",
  );
  if (!localOnly) {
    await run(process.execPath, ["scripts/audit-public.mjs"], {
      timeout: 120000,
    });
    requireThat(
      !(await run("git", ["status", "--porcelain"])).trim(),
      "COMMIT_BEFORE_PUBLIC_PACKAGE",
    );
  }
  await emptyDirectory(output);
  for (const name of [
    "dist/src",
    "dist/web",
    "migrations",
    "infra",
    "templates",
    "LICENSES",
    "LICENSE",
    "NOTICE",
    "package.json",
    "package-lock.json",
  ])
    await cp(join(projectRoot, name), join(output, name), { recursive: true });
  await mkdir(join(output, "dist/tests"), { recursive: true });
  await cp(
    join(projectRoot, "dist/tests/fixture-model.js"),
    join(output, "dist/tests/fixture-model.js"),
  );
  await cp(join(projectRoot, "docs/deployment.md"), join(output, "README.md"));
  const images = JSON.parse(await run("docker", ["image", "inspect", image]));
  const sourceCommit = (await run("git", ["rev-parse", "HEAD"])).trim();
  const dirty = !!(await run("git", ["status", "--porcelain"])).trim();
  const manifest = {
    format: 1,
    packageVersion: JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ).version,
    sourceCommit,
    dirty,
    localOnly,
    runtimeImage: image,
    runtimeImageId: images[0].Id,
    createdAt: new Date().toISOString(),
    files: await inventory(output),
  };
  await privateJson(join(output, "release-manifest.json"), manifest);
  return {
    directory: output,
    localOnly,
    sourceCommit,
    runtimeImageId: images[0].Id,
    files: manifest.files.length,
  };
}
