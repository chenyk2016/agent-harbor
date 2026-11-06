/** 只用于生成SQL；应用迁移走npm run db:migrate，不在服务启动时执行。 */
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/service/db/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
