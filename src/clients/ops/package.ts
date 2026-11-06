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
const builtDirectories = ["dist/src", "dist/web"];
const releaseFiles = [
  "migrations", "infra", "templates", "LICENSES", "LICENSE", "NOTICE",
  "package.json", "package-lock.json", ".dockerignore",
];

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
    requireThat(
      !(await run("git", ["ls-files", "--others", "--exclude-standard", "--ignored", "--", ...releaseFiles])).trim(),
      "PRIVATE_FILES_IN_PUBLIC_PACKAGE_INPUT",
    );
    for (const directory of builtDirectories) {
      const entries = await inventory(join(projectRoot, directory));
      requireThat(entries.length && entries.every(entry =>
        entry.kind === "file" &&
        /\.(?:js|css|html|sql|py)$/.test(entry.path) &&
        entry.path.split("/").every(part => !part.startsWith("."))),
      "UNEXPECTED_PUBLIC_BUILD_OUTPUT");
    }
  }
  await emptyDirectory(output);
  for (const name of [...builtDirectories, ...releaseFiles])
    await cp(join(projectRoot, name), join(output, name), { recursive: true });
  await mkdir(join(output, "dist/tests"), { recursive: true });
  await cp(
    join(projectRoot, "dist/tests/fixture-model.js"),
    join(output, "dist/tests/fixture-model.js"),
  );
  await cp(join(projectRoot, "docs/package-readme.md"), join(output, "README.md"));
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
