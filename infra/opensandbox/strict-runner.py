#!/usr/bin/env python3
"""Isolated Harbor Runner profile for OpenSandbox Server 1.2.0, Docker only."""

import argparse
import hashlib
import json
import os
import re
from importlib.metadata import version
from pathlib import Path

from opensandbox_server.cli import main
from opensandbox_server.services.docker.docker_service import DockerSandboxService

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


def install(assets: Path, seccomp: Path, network: str, workspace_root: Path) -> None:
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
    from inspect import signature
    if tuple(signature(upstream).parameters) != CREATE_PARAMETERS:
        raise RuntimeError("OpenSandbox Docker creation contract changed")

    def create(service, sandbox_id, image_uri, bootstrap_command, labels,
               environment, host_config_kwargs, exposed_ports, platform,
               unconfine_system_paths=False):
        if (len(bootstrap_command) != 4 or bootstrap_command[:2] != EXEC or
                not all(UUID.fullmatch(value) for value in bootstrap_command[2:])):
            raise RuntimeError("Strict server accepts only the fixed Harbor Runner entrypoint")
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
        expected = {
            "/workspace": "rw", "/platform/state": "rw", "/platform/run": "ro",
            "/session-env": "rw", "/dependency-cache": "rw",
            "/platform/bridge": "rw", "/etc/claude-code/managed-settings.json": "ro",
        }
        seen = {}
        for bind in host.get("binds", []):
            source, target, mode = bind.split(":")
            path = Path(source)
            if (target in seen or mode != expected.get(target) or
                    not path.exists() or not path.resolve().is_relative_to(workspace_root)):
                raise RuntimeError("Unexpected Runner mount")
            seen[target] = mode
        if seen != expected:
            raise RuntimeError("Incomplete Runner mounts")
        host.update(
            read_only=True, init=True, tmpfs={"/tmp": "rw,nosuid,size=256m,mode=1777"},
            cap_drop=["ALL"], pids_limit=256, mem_limit=4 * 1024 ** 3,
            nano_cpus=2_000_000_000, extra_hosts={"host.docker.internal": "host-gateway"},
            security_opt=["no-new-privileges", "seccomp=" + policy],
            binds=[*host["binds"], f"{assets}:{RUNTIME}:ro"],
        )
        # No caller-provided bootstrap flags or daemon credentials reach the process.
        env = [item for item in environment if item.startswith("OPENSANDBOX_SANDBOX_ID=")]
        env += ["EXECD_ENVS=/tmp/opensandbox.env"]
        # Match Harbor's existing outer profile for the native bwrap initialization.
        return upstream(service, sandbox_id, image_uri, bootstrap_command, labels, env,
                        host, exposed_ports, platform, unconfine_system_paths=True)

    DockerSandboxService._create_and_start_container = create
    # The mounted assets are already present before the container starts.
    DockerSandboxService._prepare_sandbox_runtime = lambda *_args, **_kwargs: None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--seccomp", type=Path, required=True)
    parser.add_argument("--network", required=True)
    parser.add_argument("--workspace-root", type=Path, required=True)
    args, server_args = parser.parse_known_args()
    install(args.assets.resolve(strict=True), args.seccomp, args.network, args.workspace_root.resolve(strict=True))
    import sys
    sys.argv = [sys.argv[0], *server_args]
    main()
