/** 受信离线分发，与服务共用数据锁；不会替用户安装或启用技能。 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDatabase } from "../db/client.js";
import { lockSession } from "../../runtime/storage.js";
import { SkillService } from "../skills/service.js";
import { SkillBuildManager } from "../skills/build-manager.js";
import { ExpertService } from "./service.js";
const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: npm run expert:builtin -- expert.json (stop service first)",
  );
const root = resolve(process.env.AH_DATA_DIR ?? "var/service-sessions"),
  release = await lockSession(join(root, ".service")),
  database = openDatabase();
try {
  const library = new SkillService(database.db, root);
  console.log(
    await new ExpertService(
      library,
      new SkillBuildManager(library),
    ).installBuiltin(JSON.parse(await readFile(file, "utf8"))),
  );
} finally {
  await database.close();
  await release();
}
