import { useEffect, useState } from "react";
import { Box, Button, Flex, HStack, Text, Textarea } from "@chakra-ui/react";
import type { BrowserApi } from "../../state/api.js";
import { explain } from "../../state/errors.js";
import { isActive } from "../../state/conversation-state.js";
import type { Message, ServiceEvent } from "../../../../../src/service/types.js";
import { ApiError } from "../../../../../src/clients/service-client.js";

type Environment = "preview" | "production";
type History = { messages: Message[]; events: ServiceEvent[]; through: number; hasSession: boolean };
type Pending = { clientMessageId: string; text: string };

export function AnalysisChat({ api, id, owner, environment, onEnvironment, onReport }: {
  api: BrowserApi; id: string; owner: string; environment: Environment;
  onEnvironment: (environment: Environment) => void;
  onReport: (id: string, section: string, days: string) => void;
}) {
  const base = `/applications/${id}/analysis/${environment}`;
  const key = `harbor:analysis:${owner}:${id}:${environment}`;
  const [draft, setDraft] = useState(() => sessionStorage.getItem(key + ":draft") ?? "");
  const [pending, setPending] = useState<Pending | undefined>(() => {
    try { return JSON.parse(sessionStorage.getItem(key + ":pending") ?? "null") ?? undefined; }
    catch { return undefined; }
  });
  const [history, setHistory] = useState<History>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    async function read() {
      const snapshot = await api.request<History>(base + "/messages", "GET", undefined, abort.signal);
      if (!abort.signal.aborted) setHistory(snapshot);
      return snapshot;
    }
    void (async () => {
      const initial = await read();
      if (!initial.hasSession) return;
      for await (const event of api.eventsAt(base + "/events", initial.through, abort.signal)) {
        if (event.type === "assistant.text.delta" || event.type === "analysis.report") {
          setHistory(current => !current || current.events.some(item => item.eventId === event.id) ? current : ({
            ...current, events: [...current.events, { eventId: event.id, type: event.type,
              messageId: event.data.messageId, payload: event.data, sessionId: "" }],
          }));
        } else if (event.type.startsWith("message.")) {
          await read();
        }
      }
    })().catch(error => { if (!abort.signal.aborted) setError(explain(error)); });
    return () => abort.abort();
  }, [api, base, refresh]);

  const active = history?.messages.find(message => isActive(message));
  const send = async () => {
    const request = pending ?? { clientMessageId: crypto.randomUUID(), text: draft.trim() };
    if (!request.text || busy) return;
    setBusy(true);
    setError("");
    try {
      sessionStorage.setItem(key + ":pending", JSON.stringify(request));
      setPending(request);
      await api.request(base + "/messages", "POST", request);
      sessionStorage.removeItem(key + ":pending");
      sessionStorage.removeItem(key + ":draft");
      setPending(undefined);
      setDraft("");
      setRefresh(value => value + 1);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        sessionStorage.removeItem(key + ":pending");
        setPending(undefined);
      }
      setError(explain(error));
      setRefresh(value => value + 1);
    } finally { setBusy(false); }
  };
  const stop = async (message: Message) => {
    try { await api.request(base + "/messages/" + message.id + "/cancel", "POST"); }
    catch (error) { setError(explain(error)); }
  };

  return <Flex direction="column" flex={1} minH={0} p={3} gap={3}>
    <HStack>
      <Text fontWeight="semibold">只读问数</Text>
      <Button size="xs" variant={environment === "production" ? "tint" : "ghost"} onClick={() => onEnvironment("production")}>正式</Button>
      <Button size="xs" variant={environment === "preview" ? "tint" : "ghost"} onClick={() => onEnvironment("preview")}>测试</Button>
    </HStack>
    <Box flex={1} overflowY="auto" minH={0} aria-label="问数消息">
      {!history?.messages.length && <Text color="ink3" fontSize="sm">试试问「最近 7 天报名转化如何？」</Text>}
      {history?.messages.map(message => {
        const events = history.events.filter(event => event.messageId === message.id);
        return <Box key={message.id} mb={4}>
          <Text fontSize="sm" fontWeight="semibold" whiteSpace="pre-wrap">{message.text}</Text>
          <Text fontSize="sm" whiteSpace="pre-wrap">{events.filter(event => event.type === "assistant.text.delta").map(event => event.payload.text).join("")}</Text>
          {events.filter(event => event.type === "analysis.report").map(event =>
            <Button key={event.eventId} mt={2} size="xs" variant="outline"
              onClick={() => onReport(String(event.payload.reportId), String(event.payload.section), String(event.payload.days))}>打开同一报表 · {String(event.payload.days)} 天</Button>)}
          {message.status === "failed" && <Text color="red.500" fontSize="sm">本轮分析失败，可重新发送。</Text>}
          {message.status === "interrupted" && <Text fontSize="sm">本轮已中断。</Text>}
          {message.status === "cancelled" && <Text fontSize="sm">本轮已停止。</Text>}
          {message.status === "reconciling" && <Text fontSize="sm">运行环境待核对。</Text>}
        </Box>;
      })}
    </Box>
    {error && <Text role="alert" color="red.500" fontSize="sm">{error}</Text>}
    <Textarea aria-label="输入数据问题" value={pending?.text ?? draft} maxLength={4000}
      isReadOnly={!!pending} onChange={event => {
        setDraft(event.target.value);
        sessionStorage.setItem(key + ":draft", event.target.value);
      }} />
    <HStack justify="flex-end">
      {active && active.status !== "reconciling" && <Button size="sm" onClick={() => void stop(active)}>停止分析</Button>}
      <Button size="sm" variant="tint" isLoading={busy}
        isDisabled={(!pending && !!active) || !(pending?.text ?? draft).trim()}
        onClick={() => void send()}>{pending ? "重试原问题" : "发送问题"}</Button>
    </HStack>
  </Flex>;
}
