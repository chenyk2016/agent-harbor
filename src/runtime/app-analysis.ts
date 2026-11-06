/** Runs the allowlisted SDK tools without a Docker network. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { DockerBackend } from "../docker/docker.js";
import { Store } from "./storage.js";
import { defaultProfile } from "../shared/types.js";
import type { ResidentProvider } from "./providers/resident.js";
import { ResidentJobCleanupError, runResidentJob } from "./providers/run-job.js";
import { toolNames, type AnalysisTool } from "../agent/app-analysis/tool-contract.js";

const script = fileURLToPath(new URL("../agent/app-analysis", import.meta.url));
const paths = ["/v1/messages", "/v1/messages/count_tokens"];
export interface AnalysisRun {
  sessionId: string;
  messageId: string;
  image: string;
  prompt: string;
  model: string;
  signal: AbortSignal;
  tool(name: AnalysisTool, args: unknown, signal: AbortSignal): Promise<unknown>;
  infer(path: string, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response>;
  text(text: string): Promise<unknown>;
  receipt(requestId: string): Promise<unknown>;
}

export class AnalysisCleanupError extends Error {}

export async function runAnalysis(docker: DockerBackend, run: AnalysisRun, resident?: ResidentProvider) {
  if (resident?.backendId === "opensandbox-strict-runner") return runSandboxAnalysis(docker, run, resident);
  const name = `ah-${run.messageId}`;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, run.signal, AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  try {
    const image = await docker.imageId(run.image);
    await docker.command(["create", "--name", name, "--network", "none", "--read-only", "--init",
      "--interactive", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", "1g", "--cpus", "1", "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=128m",
      "--label", "io.agent-harbor.project=agent-harbor", "--label", `harbor.owner=${docker.owner}`,
      "--label", `harbor.session=${run.sessionId}`, "--label", `harbor.attempt=${run.messageId}`,
      "--label", "harbor.purpose=app-analysis",
      "--mount", `type=bind,src=${script},dst=/platform/runtime/app-analysis,readonly`,
      "--entrypoint", "node", image, "/platform/runtime/app-analysis/runner.js"]);
    signal.throwIfAborted();
    const child = spawn("docker", ["start", "--attach", "--interactive", name],
      { stdio: ["pipe", "pipe", "ignore"], signal });
    child.stdin.on("error", () => {});
    const completion = once(child, "close").then(([code]) => code, () => null);
    async function send(value: object) {
      signal.throwIfAborted();
      if (!child.stdin.write(JSON.stringify(value) + "\n"))
        await once(child.stdin, "drain", { signal });
    }
    try {
      await consumeAnalysis(run, signal, child.stdout, completion, send);
    } finally {
      abort.abort();
      child.stdin.destroy();
      await completion;
    }
  } finally {
    try {
      const state = await docker.inspect(name);
      if (state && (state.labels["harbor.attempt"] !== run.messageId ||
        state.labels["harbor.session"] !== run.sessionId || state.labels["harbor.purpose"] !== "app-analysis"))
        throw new Error("Analysis container ownership mismatch");
      if (state) {
        await docker.stop(name);
        await docker.destroy(name);
        if (await docker.inspect(name)) throw new Error("Analysis container is still present");
      }
    } catch {
      throw new AnalysisCleanupError("ANALYSIS_CLEANUP_UNCONFIRMED");
    }
  }
}


async function runSandboxAnalysis(docker: DockerBackend, run: AnalysisRun, resident: ResidentProvider) {
  const directory = new Store(docker.root).directory(run.sessionId);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.messageId))
    throw new Error("Invalid sandbox analysis message ID");
  const attemptDirectory = join(directory, "attempts", run.messageId);
  const signal = AbortSignal.any([run.signal, AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  await cp(script, join(attemptDirectory, "analysis"), { recursive: true });
  const image = await resident.resolveImage(run.image);
  try {
    await runResidentJob(resident, {
      directory, attemptDirectory, job: "app-analysis", profile: { ...defaultProfile, image },
      task: { sessionId: run.sessionId, attemptId: run.messageId, generation: 1, prompt: "", model: run.model,
        timeoutMs: 120_000 },
    }, signal, async transport => {
      transport.diagnostics.resume();
      await consumeAnalysis(run, signal, transport.output, transport.completion!, async value => {
        signal.throwIfAborted();
        transport.send(JSON.stringify(value) + "\n");
      });
    });
  } catch (error) {
    if (error instanceof ResidentJobCleanupError) throw new AnalysisCleanupError("ANALYSIS_CLEANUP_UNCONFIRMED");
    throw error;
  }
}

async function consumeAnalysis(
  run: AnalysisRun,
  signal: AbortSignal,
  output: Readable,
  completion: Promise<number | null>,
  send: (value: object) => Promise<void>,
) {
  let successful = false;
  let calls = 0, requests = 0, textBytes = 0;
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  try {
    await send({ prompt: run.prompt, model: run.model });
    for await (const line of lines) {
      signal.throwIfAborted();
      if (line.length > 768 * 1024) throw new Error("ANALYSIS_FRAME_LIMIT");
      const frame = JSON.parse(line);
      if (frame.type === "tool" && toolNames.includes(frame.name) && Number.isSafeInteger(frame.id)) {
        let value: unknown, error = false;
        try {
          if (++calls > 6) throw new Error("ANALYSIS_TOOL_LIMIT");
          value = await run.tool(frame.name, frame.args, signal);
        } catch (cause) {
          signal.throwIfAborted();
          error = true;
          const code = typeof cause === "object" && cause && "code" in cause ? cause.code : undefined;
          value = { status: "unavailable", code: typeof code === "string" ? code : "ANALYSIS_TOOL_UNAVAILABLE" };
        }
        await send({ id: frame.id, value, error });
      } else if (frame.type === "inference" && Number.isSafeInteger(frame.id) &&
        paths.includes(frame.path) && typeof frame.body === "string" && Buffer.byteLength(frame.body) <= 512 * 1024) {
        if (++requests > 24) throw new Error("ANALYSIS_INFERENCE_LIMIT");
        const headers: Record<string, string> = {};
        if (typeof frame.version === "string") headers["anthropic-version"] = frame.version;
        if (typeof frame.beta === "string") headers["anthropic-beta"] = frame.beta;
        const response = await run.infer(frame.path, frame.body, headers, signal);
        const reply: Record<string, string> = {};
        for (const key of ["content-type", "request-id"]) {
          const value = response.headers.get(key);
          if (value) reply[key] = value;
        }
        if (reply["request-id"] && /^[a-f0-9-]{36}$/.test(reply["request-id"]))
          await run.receipt(reply["request-id"]);
        await send({ type: "headers", id: frame.id, status: response.status, headers: reply });
        if (response.body) {
          const reader = response.body.getReader();
          try {
            let bytes = 0;
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > 4 * 1024 * 1024) throw new Error("ANALYSIS_RESPONSE_LIMIT");
              await send({ type: "chunk", id: frame.id, data: Buffer.from(value).toString("base64") });
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        await send({ type: "end", id: frame.id });
      } else if (frame.type === "text" && typeof frame.text === "string") {
        textBytes += Buffer.byteLength(frame.text);
        if (textBytes > 32 * 1024) throw new Error("ANALYSIS_TEXT_LIMIT");
        await run.text(frame.text);
      } else if (frame.type === "result") {
        successful = frame.success === true;
      } else throw new Error("ANALYSIS_FRAME_INVALID");
    }
    signal.throwIfAborted();
    if (await completion !== 0 || !successful) throw new Error("ANALYSIS_SDK_FAILED");
  } finally {
    lines.close();
  }
}
