import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultProfile } from "../../shared/types.js";
import { stopAndRemove } from "./contracts.js";
import { ResidentJobCleanupError, runResidentJob } from "./run-job.js";
import type { ResidentProvider } from "./resident.js";

interface BuildJob {
  id: string;
  image: string;
  input: string;
  output: string;
  work: { type: "skill-build"; materials: string; script: string }
    | { type: "app-build"; builder: string; env: Record<string, string> };
}

export async function runBuildJob(provider: ResidentProvider, root: string, job: BuildJob, signal: AbortSignal,
  log: (text: string) => Promise<void>) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.id)) throw new Error("Invalid sandbox build ID");
  const directory = join(root, job.id);
  const attempt = randomUUID();
  const attemptDirectory = join(directory, "attempts", attempt);
  const output = join(attemptDirectory, "output");
  let confirmed = true;
  try {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await cp(job.input, join(attemptDirectory, "input"), { recursive: true, verbatimSymlinks: true });
    if (job.work.type === "skill-build") {
      await cp(job.work.materials, join(attemptDirectory, "materials"), { recursive: true, verbatimSymlinks: true });
      await writeFile(join(attemptDirectory, "build.sh"), job.work.script, { mode: 0o600 });
    } else {
      await cp(job.work.builder, join(attemptDirectory, "builder"), { recursive: true });
      await writeFile(join(attemptDirectory, "build-env.json"), JSON.stringify(job.work.env), { mode: 0o600 });
    }
    await runResidentJob(provider, {
      directory, attemptDirectory, job: job.work.type, profile: { ...defaultProfile, image: job.image },
      task: { sessionId: job.id, attemptId: attempt, generation: 1, prompt: "", model: "", timeoutMs: 0 },
    }, signal, async transport => {
      let writes = Promise.resolve();
      await Promise.all([transport.output, transport.diagnostics].map(async stream => {
        for await (const chunk of stream) {
          writes = writes.then(() => log(String(chunk).slice(0, 16_000)));
          await writes;
        }
      }));
      signal.throwIfAborted();
      const code = await transport.completion;
      if (code !== 0) throw new Error(`Sandbox build exited ${code}`);
    });
    // The old location is an empty platform-owned directory. Publish only after the writer is gone.
    await rename(output, job.output);
  } catch (error) {
    if (error instanceof ResidentJobCleanupError) confirmed = false;
    throw error;
  } finally {
    if (confirmed) await rm(attemptDirectory, { recursive: true, force: true });
  }
}

export async function stopBuildJobs(provider: ResidentProvider, sessionId: string) {
  for (const ref of await provider.findOwned(sessionId)) await stopAndRemove(provider, ref);
}
