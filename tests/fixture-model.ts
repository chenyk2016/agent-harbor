import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

type Call = { name: string; input: Record<string, unknown> };
export function fixtureModel(calls: Call[] = [], selectCall?: (body: Record<string, any>, results: any[]) => Call | undefined) {
  const requests: Array<Record<string, any>> = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : {};
      if (req.url?.includes("count_tokens")) {
        res.end('{"input_tokens":100}');
        return;
      }
      if (!req.url?.includes("/messages")) {
        res.end("{}");
        return;
      }
      requests.push(body);
      const results = (body.messages ?? [])
        .flatMap((message: any) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .filter((block: any) => block.type === "tool_result");
      // 子Agent有独立历史，不能把主Agent的第0步脚本在成员中重复执行。
      const call = selectCall ? selectCall(body,results) : calls[results.length];
      const block = call
        ? { type: "tool_use", id: `toolu_${results.length}`, ...call }
        : { type: "text", text: "FIXTURE_DONE" };
      const stop = call ? "tool_use" : "end_turn";
      const usage = {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      const message = {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [block],
        stop_reason: stop,
        stop_sequence: null,
        usage,
      };
      if (!body.stream) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 0 },
        },
      });
      send("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: call
          ? { ...block, input: {} }
          : { type: "text", text: "" },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: call
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify(call.input),
            }
          : { type: "text_delta", text: "FIXTURE_DONE" },
      });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      send("message_stop", { type: "message_stop" });
      res.end();
    } catch {
      res.writeHead(500);
      res.end("fixture failed");
    }
  });
  return { server, requests };
}
