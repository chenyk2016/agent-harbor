/** 登录方式的固定标识，供应用声明、部署和认证入口使用。 */
export const visitorProviders = ["email_password", "google"] as const;
export type VisitorProvider = (typeof visitorProviders)[number];

/** harbor-app.json 中的登录声明。省略声明的新应用使用公开模式。 */
export type AppAuthPolicy =
  { mode: "public" } | { mode: "required"; providers: VisitorProvider[] };

/** 校验源码中的声明，拒绝空的受保护入口、未知方式和重复配置。 */
export function parseAppAuth(value: unknown): AppAuthPolicy | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_APP_AUTH_POLICY");
  const { mode, providers, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length) throw new Error("INVALID_APP_AUTH_POLICY");
  if (mode === "public" && providers === undefined) return { mode };
  if (
    mode !== "required" ||
    !Array.isArray(providers) ||
    !providers.length ||
    new Set(providers).size !== providers.length ||
    providers.some((provider) => !visitorProviders.includes(provider))
  )
    throw new Error("INVALID_APP_AUTH_POLICY");
  return {
    mode,
    providers: visitorProviders.filter((provider) =>
      providers.includes(provider),
    ),
  };
}
