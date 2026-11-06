/** Administrator-owned commands only; users supply declared fields, never command fragments. */
import { readFile } from "node:fs/promises";
import { offlineTextMcpCommand } from "../../shared/mcp.js";
import { secretKeys, validId } from "./scripts.js";
export interface LocalTemplate {
  id: string;
  name: string;
  command: string[];
  secretKeys: string[];
}
export async function loadLocalTemplates(
  file?: string,
): Promise<LocalTemplate[]> {
  if (!file)
    return [
      {
        id: "text-tools",
        name: "文本工具（离线）",
        command: [...offlineTextMcpCommand],
        secretKeys: [],
      },
    ];
  const raw = JSON.parse(await readFile(file, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.templates;
  if (!Array.isArray(rows) || rows.length > 30)
    throw new Error("INVALID_MCP_TEMPLATES");
  const ids = new Set();
  return rows.map((t) => {
    if (
      !t ||
      !validId(t.id) ||
      ids.has(t.id) ||
      typeof t.name !== "string" ||
      !t.name ||
      t.image ||
      !Array.isArray(t.command) ||
      !t.command.length ||
      t.command.some(
        (v: unknown) => typeof v !== "string" || v.includes("\0"),
      ) ||
      !t.command[0].startsWith("/") ||
      ["sh", "bash", "zsh", "env"].includes(t.command[0].split("/").at(-1))
    )
      throw new Error(
        "INVALID_MCP_TEMPLATE: convert old image templates to native commands",
      );
    ids.add(t.id);
    return {
      id: t.id,
      name: t.name,
      command: t.command,
      secretKeys: secretKeys(
        t.secretKeys ?? t.fields?.map((f: any) => f.key) ?? [],
      ),
    };
  });
}
