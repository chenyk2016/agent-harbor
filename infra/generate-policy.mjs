/** 从唯一的保护根列表生成原生文件工具、Bash 沙箱的路径规则。 */
import { readFile, writeFile } from "node:fs/promises";
import { protectedRoots } from "../src/shared/paths.ts";

const policy = JSON.parse(
  await readFile(
    new URL("./managed-settings.base.json", import.meta.url),
    "utf8",
  ),
);
policy.permissions.deny = [
  ...protectedRoots.flatMap((root) => [
    `Read(/${root}/**)`,
    `Edit(/${root}/**)`,
  ]),
  ...policy.permissions.deny,
];
policy.sandbox.filesystem.denyRead = protectedRoots;
policy.sandbox.filesystem.denyWrite = protectedRoots;
await writeFile(
  new URL("./managed-settings.json", import.meta.url),
  JSON.stringify(policy, null, 2) + "\n",
);
