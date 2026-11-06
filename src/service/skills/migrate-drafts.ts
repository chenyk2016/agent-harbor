/** 一次性离线升级：旧草稿转为版本；服务锁确保没有同时编辑内容。原文件保留。 */
import { resolve, join } from "node:path";
import { openDatabase } from "../db/client.js";
import { lockSession } from "../../runtime/storage.js";
import { SkillService } from "./service.js";
const root = resolve(process.env.AH_DATA_DIR ?? "var/service-sessions");
const release = await lockSession(join(root, ".service"));
const database = openDatabase();
try {
  console.log(await new SkillService(database.db, root).migrateDrafts());
} finally {
  await database.close();
  await release();
}
