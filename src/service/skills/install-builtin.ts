/** 离线管理入口：停服后分发已审查的内置技能，复用服务锁避免两个写入者。 */
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { openDatabase } from "../db/client.js";
import { lockSession } from "../../runtime/storage.js";
import { SkillService } from "./service.js";
const [archive, displayName] = process.argv.slice(2);
if (!archive || !displayName)
  throw new Error(
    'Usage: npm run skill:builtin -- package.zip "Display name" (stop service first)',
  );
const root = resolve(process.env.AH_DATA_DIR ?? "var/service-sessions");
const release = await lockSession(join(root, ".service"));
const database = openDatabase();
try {
  const library = new SkillService(database.db, root);
  const checked = await library.packages.unzip(await readFile(archive));
  if (!checked.report.ok)
    throw new Error(JSON.stringify(checked.report.errors));
  console.log(await library.installBuiltin(displayName, checked.files));
} finally {
  await database.close();
  await release();
}
