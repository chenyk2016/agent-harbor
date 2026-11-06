import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stopAndRemove } from "./contracts.js";
import type { ResidentLaunch, ResidentProvider, RunnerTransport } from "./resident.js";

export class ResidentJobCleanupError extends Error {}

/** A finite job shares environment ownership and stop confirmation with resident execution. */
export async function runResidentJob<T>(
  provider: ResidentProvider,
  launch: Omit<ResidentLaunch, "leaseId">,
  signal: AbortSignal,
  use: (transport: RunnerTransport) => Promise<T>,
) {
  signal.throwIfAborted();
  const leaseId = randomUUID();
  const leases = join(launch.directory, "attempts", ".leases");
  await mkdir(leases, { recursive: true, mode: 0o755 });
  const lease = join(leases, leaseId);
  const refresh = () => writeFile(lease, "lease\n", { mode: 0o644 });
  await refresh();
  let transport: RunnerTransport | undefined;
  const abort = () => transport?.disconnect();
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(refresh).catch(abort);
  }, 5000);
  const planned = provider.plannedRef(launch.task.attemptId);
  let ref = planned;
  try {
    ref = await provider.create({ ...launch, leaseId });
    signal.throwIfAborted();
    await provider.start(ref);
    signal.throwIfAborted();
    transport = provider.openRunner(ref, launch.task.attemptId);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return await use(transport);
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", abort);
    transport?.disconnect();
    try {
      await stopAndRemove(provider, ref);
    } catch (cause) {
      throw new ResidentJobCleanupError("Sandbox job stop unconfirmed", { cause });
    }
    await heartbeat;
    await rm(lease, { force: true });
  }
}
