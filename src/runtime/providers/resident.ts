import type { Readable } from "node:stream";
import type { Profile, Task } from "../../shared/types.js";
import type { EnvironmentRef, SandboxProvider } from "./contracts.js";

export interface RunnerTransport {
  readonly output: Readable;
  readonly diagnostics: Readable;
  /** For an explicit finite job, returns its exit code or null on transport loss. */
  readonly completion?: Promise<number | null>;
  onFailure(listener: (error: Error) => void): void;
  send(line: string): void;
  end(): void;
  /** Detach the host connection after stopping the environment. */
  disconnect(): void;
}

export interface ResidentLaunch {
  task: Task;
  profile: Profile;
  directory: string;
  attemptDirectory: string;
  leaseId: string;
  job?: "app-analysis" | "skill-build" | "app-build";
}

export interface ResidentProvider extends SandboxProvider<ResidentLaunch> {
  /** Docker knows the resource name before create, even if the response is lost. */
  plannedRef(attemptId: string): EnvironmentRef;
  findOwnedSessions(): Promise<string[]>;
  resolveImage(image: string): Promise<string>;
  start(ref: EnvironmentRef): Promise<void>;
  stopOnCancel?(ref: EnvironmentRef): boolean;
  openRunner(ref: EnvironmentRef, runnerId: string): RunnerTransport;
}
