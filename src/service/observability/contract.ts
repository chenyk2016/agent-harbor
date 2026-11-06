/** 业务事件契约是应用源码的一部分；属性只允许有限枚举/数值，不收自由文本。 */
import { createHash } from "node:crypto";
export type Property = { type: "number" | "boolean" } | { enum: string[] };
export type EventDefinition = {
  version: number;
  source: "browser" | "server";
  properties: Record<string, Property>;
  binding?: { kind: "table_created"; table: string };
};
export type Analytics = {
  schemaVersion: 1;
  events: Record<string, EventDefinition>;
  primaryGoal?: string;
  funnels: {
    id: string;
    unit: "session";
    windowMinutes: number;
    steps: string[];
  }[];
};
export const platformEvents = new Set([
  "page_view",
  "page_error",
  "web_vital",
  "http_request",
  "resource_sample",
  "health_check",
  "edge_request",
]);
const name = /^[a-z][a-z0-9_]{0,47}$/;
export function parseAnalytics(
  value: unknown,
  tables: string[],
): Analytics | undefined {
  if (value === undefined) return;
  const input = value as Analytics;
  if (
    !input ||
    input.schemaVersion !== 1 ||
    !input.events ||
    typeof input.events !== "object" ||
    Array.isArray(input.events) ||
    Object.keys(input.events).length > 40
  )
    throw new Error("INVALID_ANALYTICS_CONTRACT");
  const events: Analytics["events"] = Object.create(null);
  for (const [key, raw] of Object.entries(input.events)) {
    if (
      !name.test(key) ||
      platformEvents.has(key) ||
      key.startsWith("harbor_") ||
      !raw ||
      !Number.isSafeInteger(raw.version) ||
      raw.version < 1 ||
      !["browser", "server"].includes(raw.source) ||
      !raw.properties ||
      typeof raw.properties !== "object" ||
      Array.isArray(raw.properties) ||
      Object.keys(raw.properties).length > 10
    )
      throw new Error("INVALID_ANALYTICS_EVENT");
    const properties: Record<string, Property> = Object.create(null);
    for (const [key, property] of Object.entries(raw.properties)) {
      if (!name.test(key) || !property || typeof property !== "object")
        throw new Error("INVALID_ANALYTICS_PROPERTY");
      if (
        "enum" in property &&
        Array.isArray(property.enum) &&
        property.enum.length > 0 &&
        property.enum.length <= 30 &&
        property.enum.every(
          (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(v),
        )
      )
        properties[key] = { enum: [...property.enum] };
      else if (
        "type" in property &&
        ["number", "boolean"].includes(property.type)
      )
        properties[key] = { type: property.type };
      else throw new Error("INVALID_ANALYTICS_PROPERTY");
    }
    if (
      raw.binding &&
      (raw.source !== "server" ||
        raw.binding.kind !== "table_created" ||
        !tables.includes(raw.binding.table))
    )
      throw new Error("INVALID_ANALYTICS_BINDING");
    events[key] = {
      version: raw.version,
      source: raw.source,
      properties,
      ...(raw.binding
        ? {
            binding: {
              kind: "table_created",
              table: raw.binding.table,
            } as const,
          }
        : {}),
    };
  }
  if (
    input.primaryGoal &&
    (!events[input.primaryGoal] ||
      events[input.primaryGoal].source !== "server")
  )
    throw new Error("INVALID_ANALYTICS_GOAL");
  const funnels = input.funnels ?? [];
  if (
    !Array.isArray(funnels) ||
    funnels.length > 5 ||
    new Set(funnels.map((f) => f.id)).size !== funnels.length
  )
    throw new Error("INVALID_ANALYTICS_FUNNELS");
  for (const f of funnels)
    if (
      !f ||
      !name.test(f.id) ||
      f.unit !== "session" ||
      !Number.isInteger(f.windowMinutes) ||
      f.windowMinutes < 1 ||
      f.windowMinutes > 1440 ||
      !Array.isArray(f.steps) ||
      f.steps.length < 2 ||
      f.steps.length > 8 ||
      f.steps.some((s) => s !== "page_view" && !events[s])
    )
      throw new Error("INVALID_ANALYTICS_FUNNEL");
  return {
    schemaVersion: 1,
    events,
    ...(input.primaryGoal ? { primaryGoal: input.primaryGoal } : {}),
    funnels: funnels.map((f) => ({
      id: f.id,
      unit: "session",
      windowMinutes: f.windowMinutes,
      steps: [...f.steps],
    })),
  };
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
      .join(",")}}`;
  return JSON.stringify(value);
}
export const definitionHash = (value: Analytics | undefined) =>
  createHash("sha256")
    .update(stable(value ?? {}))
    .digest("hex");
export function compatibleEvents(
  previous: Analytics | undefined,
  next: Analytics | undefined,
) {
  for (const [name, old] of Object.entries(previous?.events ?? {})) {
    const current = next?.events[name];
    if (
      current &&
      (current.version < old.version ||
        (current.version === old.version && stable(current) !== stable(old)))
    )
      throw new Error("ANALYTICS_EVENT_VERSION_REQUIRED");
  }
}
