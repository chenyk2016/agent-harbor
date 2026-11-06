#!/usr/bin/env python3
"""Isolated Harbor Runner profile for OpenSandbox Server 1.2.0, Docker only."""

import argparse
import fcntl
import hmac
import hashlib
import json
import os
import re
import threading
from inspect import signature
from importlib.metadata import version
from pathlib import Path
from uuid import uuid4

import docker
import uvicorn
from fastapi import HTTPException, Request
from opensandbox_server.config import CONFIG_ENV_VAR, load_config
from opensandbox_server.logging_config import configure_logging
from opensandbox_server.services.docker.docker_service import DockerSandboxService

SESSION = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
UUID = re.compile(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
RUNTIME = "/opt/opensandbox"
EXEC = ["node", RUNTIME + "/runner-bridge.cjs"]
EXEC_DAEMON = {
    "execd": "61ecd69c430ac017a3f4aadc9a41dafad9ef377747fde90ff3c98c121d5fd5c2",
    "upstream-bootstrap.sh": "6646c097e22a6da67c94c6b471a41da54874ab927ef5b52e3de3c5d9adb89289",
}
CREATE_PARAMETERS = (
    "self", "sandbox_id", "image_uri", "bootstrap_command", "labels",
    "environment", "host_config_kwargs", "exposed_ports", "platform",
    "unconfine_system_paths",
)


def install(assets: Path, seccomp: Path, network: str, workspace_root: Path, owner: str, epoch: str, lease_name: str) -> None:
    if version("opensandbox-server") != "1.2.0" or not workspace_root.is_dir():
        raise RuntimeError("Expected OpenSandbox Server 1.2.0 and an isolated workspace root")
    if network in {"bridge", "host", "none"}:
        raise RuntimeError("Use a dedicated named bridge network")
    for file, digest in EXEC_DAEMON.items():
        path = assets / file
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"Unexpected fixed runtime asset: {file}")
    for path in (assets, *(assets / name for name in (*EXEC_DAEMON, "bootstrap.sh", "runner-bridge.cjs"))):
        stat = path.stat()
        if path.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise RuntimeError("Runtime assets must be root-owned and protected")
    policy = json.dumps(json.loads(seccomp.read_text()), separators=(",", ":"))
    upstream = DockerSandboxService._create_and_start_container
    if tuple(signature(upstream).parameters) != CREATE_PARAMETERS:
        raise RuntimeError("OpenSandbox Docker creation contract changed")

    def create(service, sandbox_id, image_uri, bootstrap_command, labels,
               environment, host_config_kwargs, exposed_ports, platform,
               unconfine_system_paths=False):
        if (len(bootstrap_command) != 4 or bootstrap_command[:2] != EXEC or
                not all(UUID.fullmatch(value) for value in bootstrap_command[2:])):
            raise RuntimeError("Strict server accepts only the fixed Harbor Runner entrypoint")
        attempt = bootstrap_command[2]
        session = labels.get("harbor.os.session", "")
        if (labels.get("harbor.os.owner") != owner or labels.get("harbor.os.attempt") != attempt or
                labels.get("harbor.os.epoch") != epoch or not SESSION.fullmatch(session)):
            raise RuntimeError("Runner identity does not belong to this service")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_uri):
            raise RuntimeError("Strict server requires an exact local Runner image ID")
        image = service.docker_client.images.get(image_uri)
        if image.attrs["Config"]["User"] not in {"node", "1000", "1000:1000"}:
            raise RuntimeError("Strict Runner image must declare a non-root user")
        host = dict(host_config_kwargs)
        bindings = host.get("port_bindings", {})
        if (host.get("network_mode") != network or not bindings or
                any(not isinstance(address, tuple) or address[0] != "127.0.0.1"
                    for address in bindings.values()) or unconfine_system_paths or
                host.get("cap_add") or host.get("privileged") or host.get("devices") or
                host.get("device_requests")):
            raise RuntimeError("Strict Runner requires private loopback bindings and no additional privileges")
        directory = workspace_root / session
        attempt_directory = directory / "attempts" / attempt
        expected = {
            "/workspace": (directory / "workspace", "rw"),
            "/platform/state": (directory / "claude-state", "rw"),
            "/platform/run": (directory / "attempts", "ro"),
            "/session-env": (directory / "dependency-env", "rw"),
            "/platform/bridge": (attempt_directory / "bridge", "rw"),
            "/etc/claude-code/managed-settings.json": (attempt_directory / "managed-settings.json", "ro"),
        }
        seen = {}
        for bind in host.get("binds", []):
            source, target, mode = bind.split(":")
            path = Path(source)
            valid = expected.get(target) == (path, mode)
            if target == "/dependency-cache":
                valid = (mode == "rw" and path.parent == workspace_root / ".dependency-caches" and
                         re.fullmatch(r"[a-f0-9]{64}", path.name))
            if target in seen or not valid or not path.exists() or path.resolve() != path:
                raise RuntimeError("Unexpected Runner mount")
            seen[target] = mode
        if set(seen) != {*expected, "/dependency-cache"}:
            raise RuntimeError("Incomplete Runner mounts")
        host.update(
            read_only=True, init=True, tmpfs={"/tmp": "rw,nosuid,size=256m,mode=1777"},
            cap_drop=["ALL"], pids_limit=256, mem_limit=4 * 1024 ** 3,
            nano_cpus=2_000_000_000, extra_hosts={"host.docker.internal": "host-gateway"},
            restart_policy={"Name": "no"},
            security_opt=["no-new-privileges", "seccomp=" + policy],
            binds=[*host["binds"], f"{assets}:{RUNTIME}:ro"],
        )
        # No caller-provided bootstrap flags or daemon credentials reach the process.
        env = [item for item in environment if item.startswith("OPENSANDBOX_SANDBOX_ID=")]
        env += ["EXECD_ENVS=/tmp/opensandbox.env", f"HARBOR_MANAGER_LEASE={RUNTIME}/{lease_name}"]
        labels = {**labels, "harbor.os.profile": "strict-v1"}
        # Match Harbor's existing outer profile for the native bwrap initialization.
        clean_command = ["/usr/bin/env", "-u", "EXECD_ACCESS_TOKEN", "-u", "EXECD_ENVS", *bootstrap_command]
        return upstream(service, sandbox_id, image_uri, clean_command, labels, env,
                        host, exposed_ports, platform, unconfine_system_paths=True)

    DockerSandboxService._create_and_start_container = create
    # The mounted assets are already present before the container starts.
    DockerSandboxService._prepare_sandbox_runtime = lambda *_args, **_kwargs: None


def serve(args) -> None:
    root = args.workspace_root.resolve(strict=True)
    if root != args.workspace_root:
        raise RuntimeError("Runner workspace root must be an absolute canonical path")
    assets = args.assets.resolve(strict=True)
    owner = hashlib.sha256(str(root).encode()).hexdigest()[:16]
    epoch = str(uuid4())
    lease_name = f"manager-{owner}-{epoch}.lease"
    install(assets, args.seccomp, args.network, root, owner, epoch, lease_name)
    os.environ[CONFIG_ENV_VAR] = str(args.config)
    config = load_config()
    server = config.server
    if (os.geteuid() != 0 or server.host != "127.0.0.1" or
            not server.api_key or len(server.api_key) < 32 or config.runtime.type != "docker"):
        raise RuntimeError("Strict Runner manager requires root, local Docker and authenticated loopback")
    if (config.docker.network_mode != args.network or config.docker.publish_host != "127.0.0.1"):
        raise RuntimeError("Strict Runner manager requires the configured dedicated bridge and loopback publishing")

    # Hold through shutdown so two managers cannot fence or admit for the same root.
    with open(f"/run/lock/harbor-opensandbox-{owner}.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        client = docker.from_env(timeout=2)
        if client.info().get("LiveRestoreEnabled") is not False:
            raise RuntimeError("Strict Runner requires Docker live-restore disabled")
        network = client.networks.get(args.network).attrs
        if (network.get("Driver") != "bridge" or
                network.get("Options", {}).get("com.docker.network.bridge.enable_icc") != "false"):
            raise RuntimeError("Strict Runner requires a bridge with inter-container communication disabled")
        for previous_lease in assets.glob(f"manager-{owner}-*.lease"):
            previous_lease.unlink()
        for container in client.containers.list(all=True, filters={"label": [
            f"harbor.os.owner={owner}", "harbor.os.profile=strict-v1",
        ]}):
            if container.attrs["HostConfig"]["NetworkMode"] != args.network:
                raise RuntimeError("Runner network changed with existing containers")
            try:
                container.remove(force=True)
            except docker.errors.NotFound:
                pass

        lease = assets / lease_name
        fd = os.open(lease, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o644)
        os.fchmod(fd, 0o644)
        os.close(fd)
        stopped = threading.Event()

        def heartbeat():
            while not stopped.is_set():
                try:
                    if client.ping():
                        os.utime(lease)
                except docker.errors.DockerException:
                    pass
                stopped.wait(0.5)

        pulse = threading.Thread(target=heartbeat, daemon=True)
        pulse.start()
        from opensandbox_server.main import app

        @app.get("/harbor-runner/v1/{scope}", include_in_schema=False)
        async def runner_profile(scope: str, request: Request):
            if (scope != owner or not hmac.compare_digest(
                    request.headers.get("OPEN-SANDBOX-API-KEY", ""), server.api_key)):
                raise HTTPException(404)
            return {"profile": "strict-v1", "epoch": epoch}

        try:
            uvicorn.run(app, host=server.host, port=server.port, log_config=configure_logging(config.log))
        finally:
            stopped.set()
            pulse.join()
            lease.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--seccomp", type=Path, required=True)
    parser.add_argument("--network", required=True)
    parser.add_argument("--workspace-root", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    serve(parser.parse_args())
