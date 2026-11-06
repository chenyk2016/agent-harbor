import { test } from "node:test";
import assert from "node:assert/strict";
import { DockerBackend } from "../src/docker/docker.js";

test("missing container is distinct from an unreachable engine", async () => {
  const docker = new DockerBackend("/test");
  docker.command = async () => {
    throw Object.assign(new Error("missing"), {
      stderr: "error: no such object: test",
    });
  };
  assert.equal(await docker.inspect("test"), undefined);
  docker.command = async () => {
    throw new Error("Cannot connect to Docker daemon");
  };
  await assert.rejects(docker.inspect("test"), /Cannot connect/);
});
test("inspect requires project ownership and an explicit boolean running state", async () => {
  const docker = new DockerBackend("/test");
  const container = {
    Config: {
      Labels: {
        "io.agent-harbor.project": "agent-harbor",
        "harbor.owner": docker.owner,
      },
    },
    State: { Running: false, ExitCode: 0 },
  };
  docker.command = async () => JSON.stringify([container]);
  assert.equal((await docker.inspect("test"))?.running, false);
  container.Config.Labels["harbor.owner"] = "someone-else";
  await assert.rejects(docker.inspect("test"), /does not belong/);
  container.Config.Labels["harbor.owner"] = docker.owner;
  delete (container.State as { Running?: boolean }).Running;
  await assert.rejects(docker.inspect("test"), /no running state/);
});
