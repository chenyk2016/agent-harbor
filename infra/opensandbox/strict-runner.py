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


def install(assets: Path, seccomp: Path, network: str, workspace_root: Path, owner: str, epoch: str, lease_name: str, application_root: Path | None) -> None:
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

    def private_host(host):
        bindings = host.get("port_bindings", {})
        return (host.get("network_mode") == network and bindings and
                all(isinstance(address, tuple) and address[0] == "127.0.0.1"
                    for address in bindings.values()) and
                not any(host.get(key) for key in ("cap_add", "privileged", "devices", "device_requests")))

    def app_host(image, labels, host):
        deployment = labels.get("harbor.preview.deployment", "")
        if not application_root or not UUID.fullmatch(deployment):
            raise RuntimeError("Invalid OpenSandbox application identity")
        expected_owner = hashlib.sha256(str(application_root.parent).encode()).hexdigest()[:16]
        source = application_root / f"{deployment}.json"
        image_config = image.attrs["Config"]
        if (labels.get("harbor.preview.owner") != expected_owner or
                image_config["User"] != "node" or
                (image_config.get("Labels") or {}).get("harbor.app.runtime-access") != "v1" or not private_host(host) or
                host.get("binds") != [f"{source}:/run/harbor-app.json:ro"] or
                not source.is_file() or source.resolve() != source or
                not re.fullmatch(r"[a-zA-Z0-9_-]{43}", json.loads(source.read_bytes()).get("runtimeAccess", ""))):
            raise RuntimeError("Unexpected OpenSandbox application profile")
        host.update(
            read_only=True, init=True, tmpfs={"/tmp": "rw,nosuid,noexec,size=32m"},
            cap_drop=["ALL"], pids_limit=128, mem_limit=512 * 1024 ** 2, nano_cpus=1_000_000_000,
            security_opt=["no-new-privileges"], restart_policy={"Name": "unless-stopped"},
            extra_hosts={"host.docker.internal": "host-gateway"},
            binds=[*host["binds"], f"{assets}:{RUNTIME}:ro"],
        )
        return host

    def create(service, sandbox_id, image_uri, bootstrap_command, labels,
               environment, host_config_kwargs, exposed_ports, platform,
               unconfine_system_paths=False):
        if bootstrap_command == ["node", "/app/harbor-runtime.mjs"]:
            if unconfine_system_paths or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_uri):
                raise RuntimeError("Strict server requires an exact local application image ID")
            image = service.docker_client.images.get(image_uri)
            host = app_host(image, labels, dict(host_config_kwargs))
            if not UUID.fullmatch(sandbox_id):
                raise RuntimeError("Invalid OpenSandbox application sandbox ID")
            app_network = service.docker_client.networks.create(
                f"harbor-os-app-{sandbox_id}", driver="bridge",
                options={"com.docker.network.bridge.enable_icc": "false"},
                labels={"harbor.os.app-network": sandbox_id, "harbor.os.app-network-owner": labels["harbor.preview.owner"]},
            )
            host["network_mode"] = app_network.name
            env = ["EXECD_ENVS=/tmp/opensandbox.env"]
            try:
                return upstream(service, sandbox_id, image_uri, bootstrap_command,
                                {**labels, "harbor.os.app-profile": "strict-v1"}, env, host,
                                exposed_ports, platform, unconfine_system_paths=False)
            except Exception:
                try:
                    app_network.remove()
                except docker.errors.APIError:
                    # An allocated container still owns this network until confirmed removal.
                    pass
                raise
        if (bootstrap_command[:2] != EXEC or len(bootstrap_command) not in (4, 5) or
                not all(UUID.fullmatch(value) for value in bootstrap_command[2:4]) or
                (len(bootstrap_command) == 5 and bootstrap_command[4] not in ("mcp-probe", "app-analysis", "skill-build", "app-build"))):
            raise RuntimeError("Strict server accepts only the fixed Harbor Runner entrypoint")
        attempt = bootstrap_command[2]
        mode = bootstrap_command[4] if len(bootstrap_command) == 5 else "resident"
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
        if not private_host(host) or unconfine_system_paths:
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
        job_mounts = {
            "app-analysis": {"/platform/runtime/app-analysis": (attempt_directory / "analysis", "ro")},
            "skill-build": {
                "/source": (attempt_directory / "input", "ro"),
                "/downloads": (attempt_directory / "materials", "ro"),
                "/artifact": (attempt_directory / "output", "rw"),
                f"/platform/run/{attempt}/build.sh": (attempt_directory / "build.sh", "ro"),
            },
            "app-build": {
                "/input": (attempt_directory / "input", "ro"),
                "/output": (attempt_directory / "output", "rw"),
                "/platform/app-builder": (attempt_directory / "builder", "ro"),
                f"/platform/run/{attempt}/build-env.json": (attempt_directory / "build-env.json", "ro"),
            },
        }
        job = mode in job_mounts
        offline = mode in ("app-analysis", "skill-build")
        if job:
            expected = {
                "/platform/run/.leases": (directory / "attempts" / ".leases", "ro"),
                "/platform/bridge": (attempt_directory / "bridge", "rw"),
                **job_mounts[mode],
            }
        seen = {}
        for bind in host.get("binds", []):
            source, target, mount_mode = bind.split(":")
            path = Path(source)
            valid = expected.get(target) == (path, mount_mode)
            if not job and target == "/opt/harbor-skills":
                valid = (mount_mode == "ro" and path.parent == directory / "capabilities" and
                         re.fullmatch(r"[a-f0-9]{64}", path.name))
            if not job and target == "/opt/harbor-app-skills":
                valid = (path, mount_mode) == (attempt_directory / "application-skills", "ro")
            if not job and target == "/dependency-cache":
                valid = (mount_mode == "rw" and path.parent == workspace_root / ".dependency-caches" and
                         re.fullmatch(r"[a-f0-9]{64}", path.name))
            if target in seen or not valid or not path.exists() or path.resolve() != path:
                raise RuntimeError("Unexpected Runner mount")
            seen[target] = mount_mode
        if not (set(expected) if job else {*expected, "/dependency-cache"}).issubset(seen):
            raise RuntimeError("Incomplete Runner mounts")
        host.update(
            read_only=True, init=True, tmpfs={"/tmp": "rw,nosuid,size=256m,mode=1777"},
            cap_drop=["ALL"], pids_limit=256, mem_limit=4 * 1024 ** 3,
            nano_cpus=2_000_000_000, extra_hosts={"host.docker.internal": "host-gateway"},
            restart_policy={"Name": "no"},
            security_opt=["no-new-privileges", "seccomp=" + policy],
            binds=[*host["binds"], f"{assets}:{RUNTIME}:ro"],
        )
        if job:
            host.update(mem_limit=2 * 1024 ** 3, pids_limit=128, security_opt=["no-new-privileges"])
        if offline:
            host.update(network_mode="none", port_bindings={}, extra_hosts={})
        if mode == "app-analysis":
            host.update(nano_cpus=1_000_000_000, mem_limit=1024 ** 3,
                        tmpfs={"/tmp": "rw,nosuid,nodev,mode=1777,size=128m"})
        if mode == "skill-build":
            host.update(tmpfs={"/tmp": "rw,nosuid,size=512m,mode=1777"})
        if mode == "app-build":
            host.update(tmpfs={"/work": "rw,exec,nosuid,nodev,size=1200m,mode=1777",
                               "/tmp": "rw,noexec,nosuid,size=256m,mode=1777"})
        # No caller-provided bootstrap flags or daemon credentials reach the process.
        env = [item for item in environment if item.startswith("OPENSANDBOX_SANDBOX_ID=")]
        env += ["EXECD_ENVS=/tmp/opensandbox.env", f"HARBOR_MANAGER_LEASE={RUNTIME}/{lease_name}"]
        labels = {**labels, "harbor.os.profile": "strict-v1", "harbor.os.mode": mode}
        # Match Harbor's existing outer profile for the native bwrap initialization.
        clean_command = ["/usr/bin/env", "-u", "EXECD_ACCESS_TOKEN", "-u", "EXECD_ENVS", *bootstrap_command]
        return upstream(service, sandbox_id, image_uri, clean_command, labels, env,
                        host, [] if offline else exposed_ports, platform, unconfine_system_paths=not job)

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
    application_root = args.application_root
    if application_root is not None:
        if (application_root != application_root.resolve() or not application_root.is_dir() or
                not application_root.is_relative_to(root) or application_root == root):
            raise RuntimeError("Application configuration root must be a dedicated canonical directory")
    install(assets, args.seccomp, args.network, root, owner, epoch, lease_name, application_root)
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
            mode = container.labels.get("harbor.os.mode")
            expected_network = "none" if mode in ("app-analysis", "skill-build") else args.network
            if container.attrs["HostConfig"]["NetworkMode"] != expected_network:
                raise RuntimeError("Runner network changed with existing containers")
            try:
                container.remove(force=True)
            except docker.errors.NotFound:
                pass

        if application_root:
            app_owner = hashlib.sha256(str(application_root.parent).encode()).hexdigest()[:16]
            for app_network in client.networks.list(filters={"label": f"harbor.os.app-network-owner={app_owner}"}):
                sandbox_id = app_network.attrs.get("Labels", {}).get("harbor.os.app-network", "")
                if not UUID.fullmatch(sandbox_id) or app_network.name != f"harbor-os-app-{sandbox_id}":
                    raise RuntimeError("Application network ownership unconfirmed")
                if not client.containers.list(all=True, filters={"label": f"opensandbox.io/id={sandbox_id}"}):
                    try:
                        app_network.remove()
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
            features = ["plugins", "mcp-probe", "app-analysis", "skill-build", "app-build"]
            if application_root:
                features.append("app-runtime")
            return {"profile": "strict-v1", "epoch": epoch, "features": features}

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
    parser.add_argument("--application-root", type=Path)
    serve(parser.parse_args())
