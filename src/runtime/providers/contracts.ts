/** Persist a backend with its own resource ID. IDs only identify resources, never authorize access. */
export interface EnvironmentRef {
  backendId: string;
  resourceId: string;
}

export type EnvironmentState = "running" | "stopped" | "absent";

/** Unconfirmed operations reject, including inventory errors. Never treat them as absence. */
export interface SandboxProvider<Launch> {
  readonly backendId: string;
  create(launch: Launch): Promise<EnvironmentRef>;
  findOwned(scope: string): Promise<EnvironmentRef[]>;
  inspect(ref: EnvironmentRef): Promise<EnvironmentState>;
  /** Resolve only after the provider confirms the old writer has stopped. */
  stopAndConfirm(ref: EnvironmentRef): Promise<void>;
  /** Must independently refuse to remove a running writer. */
  remove(ref: EnvironmentRef): Promise<void>;
}

export async function stopAndRemove(
  provider: Pick<SandboxProvider<never>, "stopAndConfirm" | "remove">,
  ref: EnvironmentRef,
) {
  await provider.stopAndConfirm(ref);
  await provider.remove(ref);
}
