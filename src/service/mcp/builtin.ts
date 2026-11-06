/** 无网络、无凭据的内置MCP：用于实际文本处理及首次验证受限本地进程。 */
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "harbor-text-tools", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "text_stats",
      description: "Count Unicode characters, lines and UTF-8 bytes.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 100000 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      name: "sha256",
      description: "Calculate the SHA-256 digest of UTF-8 text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: 100000 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (r) => {
  const text = r.params.arguments?.text;
  if (
    typeof text !== "string" ||
    text.length > 100000 ||
    !["text_stats", "sha256"].includes(r.params.name)
  )
    return {
      isError: true,
      content: [{ type: "text", text: "INVALID_INPUT" }],
    };
  const result =
    r.params.name === "sha256"
      ? { sha256: createHash("sha256").update(text).digest("hex") }
      : {
          characters: [...text].length,
          lines: text.split("\n").length,
          bytes: Buffer.byteLength(text),
        };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
await server.connect(new StdioServerTransport());
