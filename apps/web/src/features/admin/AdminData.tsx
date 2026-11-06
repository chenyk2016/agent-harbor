/** 管理页共用的读取、筛选、分页与可访问数据展示。 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Input,
  Select,
  Spinner,
  Text,
  Table,
  Thead,
  Tr,
  Th,
  Tbody,
  Td,
} from "@chakra-ui/react";
import { useAdmin } from "./context.js";
import { explain } from "../../state/workspace.js";
import { ErrorNote } from "./ui.js";
import type { AdminPageResult } from "../../../../../src/shared/admin.js";
export function useAdminQuery<T>(path: string | null, interval = 0) {
  const { api, problem } = useAdmin(),
    [data, setData] = useState<T>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) {
      setData(undefined);
      setError("");
      setBusy(false);
      return;
    }
    const abort = new AbortController();
    setBusy(true);
    setError("");
    setData(undefined);
    void api
      .request<T>(path, "GET", undefined, abort.signal)
      .then((d) => {
        if (!abort.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(explain(e));
          problem(e);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [api, problem, path, version]);
  useEffect(() => {
    if (!interval) return;
    const timer = setInterval(() => setVersion((v) => v + 1), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return { data, error, busy, refresh: () => setVersion((v) => v + 1) };
}
export const stamp = (n: number | null | undefined) =>
  n ? new Date(n).toLocaleString("zh-CN") : "未记录";
export const micro = (n: number | null | undefined) =>
  n === null || n === undefined ? "未知" : "¥" + (n / 1e6).toFixed(6);
export const duration = (n: number | null | undefined) =>
  n === null || n === undefined ? "未记录" : (n / 1000).toFixed(2) + " 秒";
export const short = (v: string | null | undefined) =>
  v ? v.slice(0, 8) : "未知";
export const statusName = (v: string) =>
  ({
    ready: "正常",
    disabled: "未启用",
    stale: "延迟",
    unavailable: "不可用",
    unknown: "待核对",
    reserved: "预占中",
    settled: "已结算",
    open: "待处理",
    acknowledged: "已认领",
    resolved: "已恢复确认",
    closed: "已关闭",
    starting: "启动中",
    stopping: "停止中",
    reconciling: "待确认",
    succeeded: "成功",
    completed: "已返回",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    running: "运行中",
    accepted: "已接收",
    finalizing: "收尾中",
    unconfirmed: "结果未确认",
    legacy_recorded: "历史变更记录",
  })[v] ?? v;
export function LoadState({
  busy,
  error,
  retry,
}: {
  busy: boolean;
  error: string;
  retry: () => void;
}) {
  return error ? (
    <ErrorNote message={error} onRetry={retry} />
  ) : busy ? (
    <Flex py={6} justify="center">
      <Spinner />
    </Flex>
  ) : null;
}
export function JsonValue({ value }: { value: unknown }) {
  return (
    <Box
      as="pre"
      bg="sunken"
      borderRadius="8px"
      p={3}
      fontSize="11px"
      whiteSpace="pre-wrap"
      wordBreak="break-word"
      overflowX="auto"
    >
      {JSON.stringify(value, null, 2) ?? "未记录"}
    </Box>
  );
}
export function ChangeValues({
  before,
  after,
}: {
  before: unknown;
  after: unknown;
}) {
  return (
    <Flex gap={3} direction={{ base: "column", md: "row" }}>
      <Box flex={1} minW={0}>
        <Text fontSize="12px" mb={2}>
          变更前
        </Text>
        <JsonValue value={before} />
      </Box>
      <Box flex={1} minW={0}>
        <Text fontSize="12px" mb={2}>
          变更后 / 请求变更
        </Text>
        <JsonValue value={after} />
      </Box>
    </Flex>
  );
}
export function Pager<T>({
  page,
  update,
}: {
  page?: AdminPageResult<T>;
  update: (v: Record<string, string>) => void;
}) {
  if (!page) return null;
  return (
    <Flex gap={3} align="center" justify="space-between" mt={4} wrap="wrap">
      <Text fontSize="12px">
        共 {page.total} 条 · 第 {Math.floor(page.offset / page.limit) + 1} 页 ·{" "}
        {stamp(page.sampledAt)}
      </Text>
      <Flex gap={2}>
        <Button
          size="sm"
          isDisabled={!page.offset}
          onClick={() =>
            update({ offset: String(Math.max(0, page.offset - page.limit)) })
          }
        >
          上一页
        </Button>
        <Button
          size="sm"
          isDisabled={page.offset + page.limit >= page.total}
          onClick={() => update({ offset: String(page.offset + page.limit) })}
        >
          下一页
        </Button>
      </Flex>
    </Flex>
  );
}
export function useAdminParams(
  params: URLSearchParams,
  setParams: (v: URLSearchParams) => void,
) {
  return (v: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, x] of Object.entries(v)) {
      if (x) next.set(k, x);
      else next.delete(k);
    }
    if (!("offset" in v)) next.delete("offset");
    setParams(next);
  };
}
function dateValue(value: string | null) {
  if (!value) return "";
  const d = new Date(Number(value));
  if (!Number.isFinite(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function AdminFilters({
  params,
  update,
  states = [],
  dates = true,
  model = true,
  user = true,
  search = true,
}: {
  params: URLSearchParams;
  update: (v: Record<string, string>) => void;
  states?: Array<[string, string]>;
  dates?: boolean;
  model?: boolean;
  user?: boolean;
  search?: boolean;
}) {
  const users = useAdminQuery<Array<{ id: string; name: string }>>(
    user ? "/admin/users" : null,
  );
  const models = useAdminQuery<{
    deployments: Array<{ id: string; name: string }>;
  }>(model ? "/admin/llm" : null);
  const versions = useAdminQuery<{
    versions: Array<{ id: string; upstreamModel: string; createdAt: number }>;
  }>(
    model && params.get("model")
      ? "/admin/llm/deployments/" + encodeURIComponent(params.get("model")!)
      : null,
  );

  return (
    <Flex gap={3} wrap="wrap" mb={4} align="end">
      {search && (
        <FormControl flex="2 1 200px">
          <FormLabel fontSize="12px">关键词</FormLabel>
          <Input
            size="sm"
            aria-label="全量搜索关键词"
            placeholder="用户、模型、会话或请求编号"
            value={params.get("q") ?? ""}
            onChange={(e) => update({ q: e.target.value })}
          />
        </FormControl>
      )}
      {user && (
        <FormControl flex="1 1 150px">
          <FormLabel fontSize="12px">用户 / 操作人</FormLabel>
          <Select
            size="sm"
            aria-label="用户筛选"
            value={params.get("user") ?? ""}
            onChange={(e) => update({ user: e.target.value })}
          >
            <option value="">全部用户</option>
            {params.get("user") &&
              !users.data?.some((u) => u.id === params.get("user")) && (
                <option value={params.get("user")!}>
                  {params.get("user")}
                </option>
              )}
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </FormControl>
      )}
      {model && (
        <FormControl flex="1 1 150px">
          <FormLabel fontSize="12px">模型</FormLabel>
          <Select
            size="sm"
            aria-label="模型筛选"
            value={params.get("model") ?? ""}
            onChange={(e) => update({ model: e.target.value, version: "" })}
          >
            <option value="">全部模型</option>
            {models.data?.deployments.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </FormControl>
      )}
      {model && params.get("model") && (
        <FormControl flex="1 1 150px">
          <FormLabel fontSize="12px">模型版本</FormLabel>
          <Select
            size="sm"
            aria-label="模型版本筛选"
            value={params.get("version") ?? ""}
            onChange={(e) => update({ version: e.target.value })}
          >
            <option value="">全部版本</option>
            {versions.data?.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.upstreamModel} · {new Date(v.createdAt).toLocaleDateString()}
              </option>
            ))}
          </Select>
        </FormControl>
      )}
      {!!states.length && (
        <FormControl flex="1 1 130px">
          <FormLabel fontSize="12px">状态</FormLabel>
          <Select
            size="sm"
            aria-label="状态筛选"
            value={params.get("state") ?? ""}
            onChange={(e) => update({ state: e.target.value })}
          >
            <option value="">全部</option>
            {states.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </FormControl>
      )}
      {dates &&
        (["from", "to"] as const).map((k) => (
          <FormControl key={k} flex="1 1 190px">
            <FormLabel fontSize="12px">
              {k === "from" ? "开始时间" : "结束时间"}
            </FormLabel>
            <Input
              size="sm"
              type="datetime-local"
              aria-label={k === "from" ? "开始时间" : "结束时间"}
              value={dateValue(params.get(k))}
              onChange={(e) =>
                update({
                  [k]: e.target.value
                    ? String(new Date(e.target.value).getTime())
                    : "",
                })
              }
            />
          </FormControl>
        ))}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          update({
            q: "",
            user: "",
            model: "",
            version: "",
            state: "",
            from: "",
            to: "",
          })
        }
      >
        清除筛选
      </Button>
    </Flex>
  );
}
export function ExportButton({
  kind,
  params,
}: {
  kind: "requests" | "ledger" | "audit";
  params: URLSearchParams;
}) {
  const { api, notify, problem } = useAdmin(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const q = new URLSearchParams(params);
      q.set("kind", kind);
      const r = await api.request<{
        filename: string;
        csv: string;
        partial: boolean;
        exported: number;
        total: number;
        units: string;
      }>("/admin/operations/export?" + q);
      const url = URL.createObjectURL(
        new Blob([r.csv], { type: "text/csv;charset=utf-8" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(
        `已导出 ${r.exported}/${r.total} 条。${r.partial ? "超过5000条，请缩小时间范围。" : ""}${r.units}`,
      );
    } catch (e) {
      setError(explain(e));
      problem(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box>
      <Button size="sm" isLoading={busy} onClick={() => void run()}>
        导出 CSV
      </Button>
      {error && (
        <Text role="alert" color="red.500" fontSize="12px">
          {error}
        </Text>
      )}
    </Box>
  );
}
export function DataTable({
  heads,
  children,
}: {
  heads: string[];
  children: React.ReactNode;
}) {
  return (
    <Box
      overflowX="auto"
      border="1px solid"
      borderColor="line"
      borderRadius="10px"
    >
      <Table size="sm">
        <Thead>
          <Tr>
            {heads.map((h) => (
              <Th key={h} whiteSpace="nowrap">
                {h}
              </Th>
            ))}
          </Tr>
        </Thead>
        <Tbody>{children}</Tbody>
      </Table>
    </Box>
  );
}
export function EmptyRow({ cols }: { cols: number }) {
  return (
    <Tr>
      <Td colSpan={cols}>
        <Text py={5} color="muted" textAlign="center">
          当前筛选没有记录
        </Text>
      </Td>
    </Tr>
  );
}
