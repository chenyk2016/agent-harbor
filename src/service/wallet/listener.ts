/** 可选的Docker桥接入口：只暴露带原有钱包凭据检查的/inference，不暴露网页或管理API。 */
import express from "express";
import { createServer } from "node:http";
import { isIP } from "node:net";
import type { LlmService } from "../llm/service.js";
import type { WalletService } from "./service.js";
import { createInferenceRouter } from "./proxy.js";
import type { TracingService } from "../tracing/service.js";
export function privateInferenceHost(host: string) {
  return (
    isIP(host) === 4 &&
    (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      host === "127.0.0.1")
  );
}
export async function startInferenceListener(
  host: string,
  port: number,
  llm: LlmService,
  wallet: WalletService,
  tracing?: TracingService,
) {
  if (!privateInferenceHost(host))
    throw Error("Inference listener requires an explicit private IPv4 address");
  const app = express();
  app.disable("x-powered-by");
  app.use("/inference", createInferenceRouter(llm, wallet, tracing));
  app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: "INFERENCE_FAILED" }),
  );
  const server = createServer(app);
  await new Promise<void>((ok, no) => {
    server.once("error", no);
    server.listen(port, host, () => {
      server.removeListener("error", no);
      ok();
    });
  });
  return server;
}
