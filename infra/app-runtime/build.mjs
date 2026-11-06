/** 仅在受限Builder容器执行。来源文件不提供Dockerfile/宿主构建命令。 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import ts from "/work/node_modules/typescript/lib/typescript.js";
import { build } from "/work/node_modules/vite/dist/node/index.js";
const input = JSON.parse(await readFile("/input/harbor-app.json", "utf8"));
await cp(new URL("./browser.js", import.meta.url), "/work/__harbor_observe.js");
// 固定 Vite 构建配置：按目标环境设置访问前缀，并把版本和观测声明写入前端产物。
await build({
  root: "/work",
  configFile: false,
  base: process.env.APP_BASE_PATH,
  define: {
    __APP_REVISION__: JSON.stringify(process.env.APP_REVISION),
    __APP_ANALYTICS__: JSON.stringify(input.analytics ?? { events: {} }),
  },
  plugins: [
    {
      name: "harbor-observation",
      transformIndexHtml: {
        order: "pre",
        /** 为前端产物注入平台观测入口，业务源码不需要自己插入采集脚本。 */
        handler() {
          return [
            {
              tag: "script",
              attrs: { type: "module", src: "/__harbor_observe.js" },
              injectTo: "head-prepend",
            },
          ];
        },
      },
    },
  ],
  build: { outDir: "/output/site", sourcemap: false, emptyOutDir: true },
});
await mkdir("/output/server", { recursive: true });
const server = await readFile("/work/server/index.ts", "utf8");
// 后端转换为 ESM；这里的 diagnostics 是转译诊断，不等同于完整 TypeScript 类型检查。
const compiled = ts.transpileModule(server, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
  },
  reportDiagnostics: true,
});
if (
  compiled.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)
)
  throw new Error("SERVER_TRANSPILE_FAILED");
await writeFile("/output/server/index.mjs", compiled.outputText);
await writeFile("/output/harbor-app.json", JSON.stringify(input));
const pkg = JSON.parse(await readFile("/work/package.json", "utf8"));
// 运行产物去掉脚本和开发依赖声明，随后仅保留生产依赖。
await writeFile(
  "/output/package.json",
  JSON.stringify({ ...pkg, scripts: undefined, devDependencies: undefined }),
);
await new Promise((resolve, reject) => {
  const child = spawn(
    "npm",
    ["prune", "--omit=dev", "--ignore-scripts", "--offline"],
    { cwd: "/work", stdio: "inherit" },
  );
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error("RUNTIME_DEPENDENCY_PRUNE_FAILED")),
  );
});
await cp("/work/node_modules", "/output/node_modules", {
  recursive: true,
  verbatimSymlinks: true,
});
