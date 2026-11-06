/** 应用数据契约：只允许声明安全的表/字段；运行账号不承担DDL。 */
import { parseAnalytics, type Analytics } from "../observability/contract.js";
import { createHash } from "node:crypto";
import { parseAppAuth, type AppAuthPolicy } from "./visitor-auth/policy.js";
import { fail } from "../types.js";

/** 应用可声明的单个业务字段；类型受平台限制，maxLength 仅适用于文本字段。 */
export type Field = {
  type: "text" | "number" | "boolean" | "timestamp";
  maxLength?: number;
};
/** harbor-app.json 的受校验结构，描述模板版本、业务表、匿名读写权限及可选观测事件。 */
export type AppManifest = {
  analytics?: Analytics;
  auth?: AppAuthPolicy;
  formatVersion: 1 | 2;
  template: "react-node-v1";
  tables: Record<
    string,
    {
      fields: Record<string, Field>;
      publicCreate: boolean;
      publicRead: boolean;
    }
  >;
};
const identifier = /^[a-z][a-z0-9_]{0,39}$/;
/** 验证业务表或字段名称并加 SQL 标识符引号；拒绝平台保留字段和 harbor_ 前缀。 */
export function sqlName(value: string) {
  if (
    !identifier.test(value) ||
    ["id", "created_at", "updated_at", "row_version"].includes(value) ||
    value.startsWith("harbor_")
  )
    throw new Error("INVALID_DATA_IDENTIFIER");
  return `"${value}"`;
}
/** 把不可信 JSON 转成平台支持的数据声明，校验版本、表字段数量、字段类型和显式访问权限。 */
export function parseManifest(value: unknown): AppManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_APP_MANIFEST");
  const input = value as Record<string, unknown>;
  if (input.formatVersion === 2 && input.template === "react-node-v1" && input.tables === undefined) {
    const analytics = parseAnalytics(input.analytics, []);
    const auth = parseAppAuth(input.auth);
    return { formatVersion: 2, template: "react-node-v1", tables: {},
      ...(analytics ? { analytics } : {}), ...(auth ? { auth } : {}) };
  }
  if (
    input.formatVersion !== 1 ||
    input.template !== "react-node-v1" ||
    !input.tables ||
    typeof input.tables !== "object" ||
    Array.isArray(input.tables)
  )
    throw new Error("UNSUPPORTED_APP_MANIFEST");
  const tables: AppManifest["tables"] = Object.create(null);
  const entries = Object.entries(input.tables);
  if (entries.length > 10) throw new Error("TOO_MANY_TABLES");
  for (const [name, raw] of entries) {
    sqlName(name);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("INVALID_TABLE");
    const table = raw as Record<string, unknown>;
    if (
      !table.fields ||
      typeof table.fields !== "object" ||
      Array.isArray(table.fields)
    )
      throw new Error("INVALID_FIELDS");
    if (
      typeof table.publicCreate !== "boolean" ||
      typeof table.publicRead !== "boolean"
    )
      throw new Error("EXPLICIT_DATA_POLICY_REQUIRED");
    const fields: Record<string, Field> = Object.create(null);
    const fieldEntries = Object.entries(table.fields);
    if (!fieldEntries.length || fieldEntries.length > 40)
      throw new Error("INVALID_FIELD_COUNT");
    for (const [key, definition] of fieldEntries) {
      sqlName(key);
      if (
        !definition ||
        typeof definition !== "object" ||
        Array.isArray(definition)
      )
        throw new Error("INVALID_FIELD");
      const field = definition as Field;
      if (!["text", "number", "boolean", "timestamp"].includes(field.type))
        throw new Error("UNSUPPORTED_FIELD_TYPE");
      if (
        field.maxLength !== undefined &&
        (field.type !== "text" ||
          !Number.isSafeInteger(field.maxLength) ||
          field.maxLength < 1 ||
          field.maxLength > 10000)
      )
        throw new Error("INVALID_FIELD_LENGTH");
      fields[key] = {
        type: field.type,
        ...(field.maxLength === undefined
          ? {}
          : { maxLength: field.maxLength }),
      };
    }
    tables[name] = {
      fields,
      publicCreate: table.publicCreate,
      publicRead: table.publicRead,
    };
  }
  const analytics = parseAnalytics(input.analytics, Object.keys(tables));
  const auth = parseAppAuth(input.auth);
  return {
    formatVersion: 1,
    template: "react-node-v1",
    tables,
    ...(analytics ? { analytics } : {}),
    ...(auth ? { auth } : {}),
  };
}
/** 对排序后的表结构和数据权限生成稳定摘要，用于迁移去重；观测 analytics 不参与该数据摘要。 */
export function manifestHash(manifest: AppManifest) {
  const tables = Object.fromEntries(
    Object.keys(manifest.tables)
      .sort()
      .map((name) => {
        const table = manifest.tables[name];
        return [
          name,
          {
            ...table,
            fields: Object.fromEntries(
              Object.entries(table.fields).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ),
          },
        ];
      }),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        formatVersion: manifest.formatVersion,
        template: manifest.template,
        tables,
      }),
    )
    .digest("hex");
}
/** 把平台字段类型映射为固定 PostgreSQL 类型，数据声明不能传入任意 SQL 类型。 */
const columnType = (field: Field) =>
  ({
    text: "text",
    number: "double precision",
    boolean: "boolean",
    timestamp: "timestamptz",
  })[field.type];
/** 只输出新表/可空字段扩展。权限配置变更不偷偷改列结构。 */
export function migrationPlan(
  previous: AppManifest | undefined,
  next: AppManifest,
): string[] {
  const statements: string[] = [];
  for (const [name, old] of Object.entries(previous?.tables ?? {})) {
    const table = next.tables[name];
    if (!table) fail(409, "DESTRUCTIVE_SCHEMA_CHANGE");
    for (const [key, field] of Object.entries(old.fields)) {
      if (!table.fields[key] || table.fields[key].type !== field.type)
        fail(409, "DESTRUCTIVE_SCHEMA_CHANGE");
    }
  }
  for (const [name, table] of Object.entries(next.tables)) {
    const old = previous?.tables[name];
    if (!old) {
      const columns = Object.entries(table.fields).map(
        ([key, field]) => `${sqlName(key)} ${columnType(field)}`,
      );
      statements.push(
        `CREATE TABLE ${sqlName(name)} (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), row_version bigint NOT NULL DEFAULT 1, ${columns.join(", ")})`,
      );
    } else
      for (const [key, field] of Object.entries(table.fields)) {
        if (!old.fields[key])
          statements.push(
            `ALTER TABLE ${sqlName(name)} ADD COLUMN ${sqlName(key)} ${columnType(field)}`,
          );
      }
  }
  return statements;
}
