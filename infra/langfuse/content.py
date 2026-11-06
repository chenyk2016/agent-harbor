"""Bounded projection of native generation content at the OTLP export boundary."""
import json
import os
import re

OMITTED = "[omitted]"
REDACTED = "[redacted]"
SENSITIVE_KEY = re.compile(r"password|passwd|secret|credential|authorization|cookie|api.?key|access.?token|refresh.?token|private.?key|^headers$|^env$|^base64$|^b64_json$", re.I)
SENSITIVE_PATH = re.compile(r"(?<![\w.])(?:\.env(?:[.\w-]*)?|\.ssh|\.aws|\.npmrc|\.netrc|/proc/\S*/environ|\w+\.(?:pem|p12|key))\b", re.I)
CREDENTIAL = re.compile(
    r"-----BEGIN [^-\n]{1,40}PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]{1,40}PRIVATE KEY-----|\Z)"
    r"|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]{8,}"
    r"|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}"
    r"|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"
    r"|\b(?:[\w.-]*(?:password|passwd|secret|credential|api[_-]?key|(?:access|refresh)[_-]?token|authorization|cookie))[\"']?\s*[:=]\s*(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;}\]]+)"
    r"|\b[a-z][a-z0-9+.-]*://[^\s/@]+:[^\s/@]+@"
    r"|data:[^\s,]{1,80};base64,[A-Za-z0-9+/=]+",
    re.I,
)
EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", re.I)
MEDIA = {"image", "image_url", "input_image", "document", "file", "input_file", "audio", "input_audio", "thinking", "redacted_thinking", "reasoning", "reasoning_content"}


def redact_content(raw, limit):
    """Return valid JSON within the wire budget, or omit an unsafe/oversize value."""
    if not isinstance(raw, str) or len(raw) > limit * 8:
        return json.dumps(OMITTED)
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        value = raw
    secrets = tuple(
        v for k, v in os.environ.items()
        if len(v) >= 8 and re.search(r"key|token|secret|password", k, re.I)
    )
    protected_tools = set()
    remaining = 4000

    def find_protected_tools(v, depth=0):
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 12:
            return
        if isinstance(v, list):
            for item in v[:128]:
                find_protected_tools(item, depth + 1)
        elif isinstance(v, dict):
            arguments = v.get("input")
            function = v.get("function")
            if isinstance(function, dict):
                arguments = function.get("arguments")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except (ValueError, RecursionError):
                    arguments = {"command": arguments}
            if isinstance(v.get("id"), str) and isinstance(arguments, dict) and protected_location(arguments):
                protected_tools.add(v["id"])
            for item in list(v.values())[:128]:
                find_protected_tools(item, depth + 1)

    def protected_location(fields):
        return any(
            isinstance(fields.get(key), str) and SENSITIVE_PATH.search(fields[key])
            for key in ("path", "file_path", "command")
        )

    find_protected_tools(value)
    nodes = 0

    def clean(v, depth=0):
        nonlocal nodes
        nodes += 1
        if depth > 12 or nodes > 4000:
            return OMITTED
        if isinstance(v, str):
            if SENSITIVE_PATH.search(v):
                return OMITTED
            for secret in secrets:
                v = v.replace(secret, REDACTED)
            v = EMAIL.sub(REDACTED, CREDENTIAL.sub(REDACTED, v))
            return v if len(v) <= 24000 else v[:24000] + " [truncated]"
        if isinstance(v, list):
            return [clean(item, depth + 1) for item in v[:128]] + ([OMITTED] if len(v) > 128 else [])
        if isinstance(v, dict):
            kind = v.get("type")
            if (isinstance(kind, str) and kind in MEDIA) or protected_location(v):
                return OMITTED
            tool_ref = v.get("tool_use_id", v.get("tool_call_id"))
            if isinstance(tool_ref, str) and tool_ref in protected_tools:
                return OMITTED
            result = {}
            for key, item in list(v.items())[:128]:
                if SENSITIVE_KEY.search(key) or key in MEDIA or key in ("signature", "thinking", "source"):
                    continue
                safe_key = clean(key, depth + 1)
                if safe_key == key and len(key) <= 128:
                    if key == "arguments" and isinstance(item, str):
                        try:
                            item = json.loads(item)
                        except (ValueError, RecursionError):
                            pass
                    result[key] = clean(item, depth + 1)
            return result
        return v

    try:
        projected = json.dumps(clean(value), ensure_ascii=False, allow_nan=False)
        return projected if len(projected.encode("utf-8")) <= limit else json.dumps(OMITTED)
    except (ValueError, TypeError, RecursionError, UnicodeError):
        return json.dumps(OMITTED)
