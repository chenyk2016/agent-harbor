const sensitiveKey =
  /password|passwd|secret|credential|authorization|cookie|api.?key|access.?token|refresh.?token|private.?key|^headers$|^env$|^base64$/i;
const sensitivePath =
  /(?:^|[^\w.])(?:\.env(?:[.\w-]*)?|\.ssh|\.aws|\.npmrc|\.netrc|\/proc\/\S*\/environ|\w+\.(?:pem|p12|key))\b/i;
const credentials =
  /-----BEGIN [^-\n]{1,40}PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]{1,40}PRIVATE KEY-----|$)|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]{8,}|(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b[\w.-]*(?:password|passwd|secret|credential|api[_-]?key|(?:access|refresh)[_-]?token|authorization|cookie)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@|data:[^\s,]{1,80};base64,[A-Za-z0-9+/=]+/gi;
const email = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const omitted = "[omitted]";
const media = new Set([
  "image",
  "image_url",
  "input_image",
  "document",
  "file",
  "input_file",
  "audio",
  "thinking",
  "redacted_thinking",
  "reasoning",
]);

export const contentTools = new Set([
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
]);

export function projectToolContent(
  input: unknown,
  output: unknown,
  secrets: readonly string[] = [],
) {
  let remaining = 700;
  function clean(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 8) return omitted;
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    )
      return value;
    if (typeof value === "string") {
      if (value.length > 64 * 1024 || sensitivePath.test(value)) return omitted;
      let text = value;
      for (const secret of secrets) {
        if (secret.length >= 8) text = text.replaceAll(secret, "[redacted]");
      }
      text = text
        .replace(credentials, "[redacted]")
        .replace(email, "[redacted]");
      return text.length <= 8192 ? text : text.slice(0, 8192) + " [truncated]";
    }
    if (Array.isArray(value))
      return value.slice(0, 48).map((item) => clean(item, depth + 1));
    if (!value || typeof value !== "object") return omitted;
    const fields = value as Record<string, unknown>;
    if (media.has(String(fields.type))) return omitted;
    return Object.fromEntries(
      Object.entries(fields)
        .slice(0, 48)
        .filter(
          ([key]) =>
            key.length <= 128 &&
            !sensitiveKey.test(key) &&
            !media.has(key) &&
            clean(key, depth + 1) === key,
        )
        .map(([key, item]) => [key, clean(item, depth + 1)]),
    );
  }

  const fields =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  // When the operation names a protected location, omit both sides of the call.
  if (
    ["command", "file_path", "path"].some(
      (key) =>
        typeof fields[key] === "string" && sensitivePath.test(fields[key]),
    )
  ) {
    return { input: omitted, output: omitted };
  }
  function bounded(value: unknown, limit: number) {
    const result = clean(value, 0);
    return Buffer.byteLength(JSON.stringify(result)) <= limit
      ? result
      : omitted;
  }
  return {
    input: bounded(input, 16 * 1024),
    output: bounded(output, 32 * 1024),
  };
}
