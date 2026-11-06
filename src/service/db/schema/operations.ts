/** 运维记录：只登记已完成的数据导入，用于识别同一份备份的重复执行。 */
import { bigint, integer, pgTable, text } from "drizzle-orm/pg-core";

export const importRuns = pgTable("import_runs", {
  fingerprint: text("fingerprint").primaryKey(),
  sourcePath: text("sourcePath").notNull(),
  sourceVersion: integer("sourceVersion").notNull(),
  importedAt: bigint("importedAt", { mode: "number" }).notNull(),
  counts: text("counts").notNull(),
});
