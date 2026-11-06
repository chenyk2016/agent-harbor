import { once } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import type { RunnerTransport } from "../runtime/providers/resident.js";

export function openRunnerSocket(directory: string): RunnerTransport {
  // Linux Unix socket paths are limited to 107 bytes, including the host prefix.
  const fd = openSync(directory, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY);
  const socket = createConnection({ path: `/proc/self/fd/${fd}/runner.sock` });
  socket.once("close", () => closeSync(fd));
  const output = new PassThrough(), diagnostics = new PassThrough();
  let notify: (error: Error) => void = () => {};
  void (async () => {
    let pending = Buffer.alloc(0);
    for await (const chunk of socket) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const size = pending.readUInt32BE(1);
        const destination = pending[0] === 1 ? output : pending[0] === 2 ? diagnostics : undefined;
        if (!destination || size > 1024 * 1024) throw new Error("Invalid Runner bridge frame");
        if (pending.length < size + 5) break;
        const bytes = pending.subarray(5, size + 5);
        pending = pending.subarray(size + 5);
        if (!destination.write(bytes)) await once(destination, "drain");
      }
    }
    throw new Error(pending.length ? "Truncated Runner bridge frame" : "Runner bridge closed");
  })().catch(error => {
    notify(error);
    socket.destroy();
  }).finally(() => {
    output.end();
    diagnostics.end();
  });
  return {
    output, diagnostics,
    onFailure(listener) { notify = listener; },
    send(line) {
      if (socket.destroyed || socket.writableEnded || socket.writableLength + Buffer.byteLength(line) > 1024 * 1024)
        throw new Error("Runner bridge cannot accept input");
      socket.write(line);
    },
    end() { socket.end(); },
    disconnect() { socket.destroy(); },
  };
}
