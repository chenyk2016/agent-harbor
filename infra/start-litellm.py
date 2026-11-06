"""Build optional telemetry config in the container, then replace this process with LiteLLM.

No credential values are written to YAML or diagnostics. Unconfigured/invalid telemetry
never registers a callback. Keep this contract aligned with service/tracing/config.ts.
"""
import os
import re
import sys
from urllib.parse import urlsplit
import yaml


def configure(source, destination, env):
    names = ("AH_LANGFUSE_HOST", "AH_LANGFUSE_PUBLIC_KEY", "AH_LANGFUSE_SECRET_KEY")
    values = [env.get(name, "").strip() for name in names]
    host, public, secret = values
    issues = [name for name, value in zip(names, values) if not value]
    if any(values):
        try:
            u = urlsplit(host)
            valid = u.scheme == "https" or u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "host.docker.internal")
            if not valid or u.username or u.password or u.path not in ("", "/") or u.query or u.fragment or not u.hostname:
                issues.append(names[0])
            else:
                host = host.rstrip("/")
        except ValueError:
            issues.append(names[0])
        for name, value in zip(names[1:], values[1:]):
            if value and (not re.fullmatch(r"[\x21-\x7e]{1,512}", value) or ":" in value):
                issues.append(name)
    mode = env.pop("AH_LANGFUSE_CONTENT_MODE", "").strip() or "metadata"
    if mode not in ("metadata", "redacted"):
        issues.append("AH_LANGFUSE_CONTENT_MODE")
    state = "disabled" if not any(values) else "invalid" if issues else "enabled"
    config = yaml.safe_load(open(source))
    settings = config.setdefault("litellm_settings", {})
    # Never trust a stale generated callback or a second native logging configuration.
    settings["callbacks"] = [c for c in settings.get("callbacks", []) if c not in ("langfuse", "langfuse_otel")]
    redacted = state == "enabled" and mode == "redacted"
    settings["turn_off_message_logging"] = not redacted
    config.setdefault("general_settings", {})["store_prompts_in_spend_logs"] = False
    settings["log_raw_request_response"] = False
    for key in list(env):
        if key.startswith(("LANGFUSE_", "LITELLM_OTEL_", "OTEL_")):
            del env[key]
    env.pop("HARBOR_LANGFUSE_METADATA_ONLY", None)
    env.pop("HARBOR_LANGFUSE_EXPORT_MODE", None)
    env.pop("HARBOR_LANGFUSE_EXPORT_PROXY", None)
    proxy = env.pop("AH_LANGFUSE_CONTAINER_PROXY", "").strip()
    if state == "enabled":
        settings["callbacks"].append("langfuse_otel")
        env.update(LANGFUSE_OTEL_HOST=host, LANGFUSE_PUBLIC_KEY=public,
                   LANGFUSE_SECRET_KEY=secret, LITELLM_OTEL_V2="true",
                   LITELLM_OTEL_LANGFUSE_SPAN_SCOPE="llm_only",
                   OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT="span_only" if redacted else "no_content")
        env["HARBOR_LANGFUSE_EXPORT_MODE"] = mode
        if proxy:
            env["HARBOR_LANGFUSE_EXPORT_PROXY"] = proxy
        env["PYTHONPATH"] = "/app/harbor-observation" + (":" + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    # The server needs native variables, never the original Harbor configuration group.
    for name in names:
        env.pop(name, None)
    with open(destination, "w") as f:
        yaml.safe_dump(config, f)
    os.chmod(destination, 0o600)
    print("Harbor Langfuse: " + state + (" (" + ",".join(sorted(set(issues))) + ")" if state == "invalid" else ""), flush=True)
    return state


if __name__ == "__main__":
    configure("/app/harbor.yaml", "/tmp/harbor-effective.yaml", os.environ)
    os.execvp("litellm", ["litellm", "--config", "/tmp/harbor-effective.yaml", *sys.argv[1:]])
