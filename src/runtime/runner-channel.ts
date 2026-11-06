/**
 * 宿主与常驻Runner之间的一条docker exec管道。
 * run发送一条消息并等待对应result；读取循环始终存在，不逐轮等待进程退出。
 */
import type { RunnerTransport } from "./providers/resident.js";
import { createInterface } from "node:readline";
import type { RunnerCommand, RunnerEvent } from "../shared/runner-protocol.js";
import type { Task } from "../shared/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

/**
 * 把“等待结果”和“通知结果”分开：run等待promise，读取循环调用resolve/reject。
 * 这里只用于连接就绪和单轮结果，不建立另一套任务队列。
 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // 进程可能在调用方开始await之前失败；原promise仍保留失败供调用方接收。
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export class RunnerChannel {
  private readySignal = createDeferred<void>();
  private activeRequest?: { task: Task; result: Deferred<RunnerEvent> };
  private lastSequence = 0;
  private failure?: Error;
  private isClosing = false;

  // 读取循环退出后完成。宿主关闭容器时等它结束，再回收日志和凭证。
  readonly drained: Promise<void>;

  constructor(
    readonly transport: RunnerTransport,
    readonly sessionId: string,
    readonly runnerId: string,
    private onEvent: (event: RunnerEvent) => Promise<void>,
    private onFailure: (error: Error) => void,
  ) {
    transport.onFailure(error => this.fail(error));
    this.drained = this.readEvents().catch(error => this.fail(error));
  }

  async run(task: Task, onSubmitted: () => void = () => {}) {
    await this.readySignal.promise;
    if (this.activeRequest) throw new Error("Runner already running");

    const result = createDeferred<RunnerEvent>();
    // 先登记等待者再发送，避免很快返回的result找不到对应请求。
    this.activeRequest = { task, result };
    try {
      this.send({ type: "message", task });
      onSubmitted();
    } catch (error) {
      this.activeRequest = undefined;
      throw error;
    }
    return result.promise;
  }

  send(command: RunnerCommand) {
    if (this.failure || this.isClosing) {
      throw this.failure ?? new Error("Runner closing");
    }
    this.transport.send(JSON.stringify(command) + "\n");
  }

  private async readEvents() {
    for await (const line of createInterface({ input: this.transport.output })) {
      if (this.isClosing) continue;
      const event: RunnerEvent = JSON.parse(line);
      if (event.sessionId !== this.sessionId || event.runnerId !== this.runnerId ||
          !Number.isInteger(event.seq) || event.seq <= this.lastSequence) {
        throw new Error("Invalid resident Runner event sequence/identity");
      }
      this.lastSequence = event.seq;

      // 先保存事件，再通知run完成；下一轮不能抢在上一轮结果落盘之前进入。
      await this.onEvent(event);
      if (event.type === "runner.ready") this.readySignal.resolve();
      if (event.type === "runner.failed" || event.type === "input.rejected") {
        throw new Error(String(event.payload.message ?? "Runner rejected input"));
      }
      if (event.type === "agent.result") this.finishActiveRequest(event);
    }
    this.fail(new Error("Resident Runner output ended"));
  }

  private finishActiveRequest(event: RunnerEvent) {
    const request = this.activeRequest;
    if (!request || event.attemptId !== request.task.attemptId ||
        event.generation !== request.task.generation) {
      throw new Error("Result does not belong to the active turn");
    }
    this.activeRequest = undefined;
    request.result.resolve(event);
  }

  /** 多种退出通知可能相继到达，只报告第一次失败，并唤醒所有等待中的调用方。 */
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.readySignal.reject(error);
    this.activeRequest?.result.reject(error);
    if (!this.isClosing) this.onFailure(error);
  }

  /** 关闭管道只是请求，不能证明工具后代已退出；容器停止由宿主另行确认。 */
  close() {
    if (this.isClosing) return;
    this.isClosing = true;
    if (!this.failure) {
      this.transport.send(JSON.stringify({ type: "close" }) + "\n");
    }
    this.transport.end();
    this.fail(new Error("Runner closed"));
  }
}
