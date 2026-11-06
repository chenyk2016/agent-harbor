/** One managed policy feeds native Bash and local MCP; this is a field adapter, not a settings merger. */
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { posix } from "node:path";
export function mcpSandboxPolicy(policy: Record<string, any>, home: string) {
  const s = policy.sandbox;
  if (
    !s?.enabled ||
    !s.failIfUnavailable ||
    s.allowUnsandboxedCommands !== false ||
    s.filesystem?.disabled ||
    s.enableWeakerNestedSandbox ||
    s.enableWeakerNetworkIsolation ||
    s.allowNestedUserNamespaces
  )
    throw new Error("MCP_SANDBOX_POLICY_UNSAFE");
  const known = (value: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(value).some((key) => !keys.includes(key)))
      throw new Error("MCP_SANDBOX_FIELD_UNSUPPORTED");
  };
  known(s, [
    "enabled",
    "failIfUnavailable",
    "allowUnsandboxedCommands",
    "autoAllowBashIfSandboxed",
    "excludedCommands",
    "enableWeakerNestedSandbox",
    "enableWeakerNetworkIsolation",
    "filesystem",
    "network",
    "credentials",
    "allowNestedUserNamespaces",
  ]);
  known(s.filesystem ?? {}, [
    "disabled",
    "allowManagedReadPathsOnly",
    "allowWrite",
    "denyRead",
    "denyWrite",
    "allowRead",
  ]);
  known(s.network ?? {}, [
    "allowManagedDomainsOnly",
    "allowedDomains",
    "deniedDomains",
    "allowUnixSockets",
    "allowAllUnixSockets",
    "allowLocalBinding",
  ]);
  const paths = (items: string[] = []) =>
    items.map((p) => {
      if (typeof p !== "string" || !p || p.includes("\0") || /[*?\[\]]/.test(p))
        throw new Error("MCP_SANDBOX_PATH_INVALID");
      return posix.resolve(
        "/workspace",
        p === "~"
          ? "/platform/state"
          : p.startsWith("~/")
            ? "/platform/state/" + p.slice(2)
            : p,
      );
    });
  // A native approval/source-control option is not an OS sandbox option. Copy supported security fields explicitly.
  const f = s.filesystem ?? {},
    n = s.network ?? {};
  for (const entry of [
    ...(s.credentials?.envVars ?? []),
    ...(s.credentials?.files ?? []),
  ])
    if (entry.mode !== "deny")
      throw new Error("MCP_CREDENTIAL_MODE_UNSUPPORTED");
  return SandboxRuntimeConfigSchema.parse({
    filesystem: {
      denyRead: paths(f.denyRead),
      allowRead: paths(f.allowRead),
      allowWrite: [...new Set(["/workspace", home, ...paths(f.allowWrite)])],
      denyWrite: paths(f.denyWrite),
    },
    network: {
      allowedDomains: n.allowedDomains ?? [],
      deniedDomains: n.deniedDomains ?? [],
      allowUnixSockets: n.allowUnixSockets ?? [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    credentials: s.credentials
      ? {
          ...s.credentials,
          files: s.credentials.files?.map((entry: Record<string, unknown>) => ({
            ...entry,
            path: paths([entry.path as string])[0],
          })),
        }
      : undefined,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowNestedUserNamespaces: false,
  });
}
