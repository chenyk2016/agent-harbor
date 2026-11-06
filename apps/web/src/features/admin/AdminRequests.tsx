/** 扣费待核对：队列表格 + 右侧核对抽屉，保留页码并在当前页清空时回退。 */
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Input,
  Spinner,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from "@chakra-ui/react";
import { RefreshCw, Search } from "lucide-react";
import { Link as RouteLink, useSearchParams } from "react-router";
import { useAdmin } from "./context.js";
import { explain } from "../../state/workspace.js";
import { money, type WalletData } from "../wallet/WalletPanel.js";
import {
  AdminPage,
  Card,
  EmptyState,
  ErrorNote,
  RefreshMeta,
  age,
  requestAgeTone,
} from "./ui.js";
import { Pill } from "../../shared/ui.js";
import { RequestEvidence } from "./RequestEvidence.js";
import type { AdminUser, PendingQueue, PendingRequest } from "./types.js";

export function AdminRequests() {
  const { api, problem, notify } = useAdmin();
  const [params, setParams] = useSearchParams();
  const offset = Math.max(0, Number(params.get("offset") ?? 0) || 0);
  const query = params.get("q") ?? "";
  const ageFilter = params.get("age") === "24h" ? "24h" : "all";
  const [data, setData] = useState<PendingQueue>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, refresh] = useState(0);
  const [target, setTarget] = useState<PendingRequest>();
  const [details, setDetails] = useState<WalletData>();
  const [detailError, setDetailError] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolveError, setResolveError] = useState("");

  const update = (
    values: Record<string, string | number | undefined>,
    replace = false,
  ) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next, { replace });
  };

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void api
      .request<PendingQueue>(
        `/admin/wallet/requests?offset=${offset}&q=${encodeURIComponent(query)}&age=${ageFilter}`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (abort.signal.aborted) return;
        if (!value.requests.length && offset > 0) {
          update({ offset: Math.max(0, offset - 50) }, true);
          return;
        }
        setData(value);
      })
      .catch((value) => {
        if (abort.signal.aborted) return;
        setError(explain(value));
        problem(value);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, offset, query, ageFilter, version, problem]);

  useEffect(() => {
    const abort = new AbortController();
    void api
      .request<AdminUser[]>("/admin/users", "GET", undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setUsers(value);
      })
      .catch(() => {
        // 用户名称读取失败时仍用 ID 处理队列。
      });
    return () => abort.abort();
  }, [api]);

  useEffect(() => {
    if (!target) {
      setDetails(undefined);
      setDetailError("");
      return;
    }
    const abort = new AbortController();
    setDetails(undefined);
    setDetailError("");
    void api
      .request<WalletData>(
        `/admin/wallet/users/${encodeURIComponent(target.userId)}`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setDetails(value);
      })
      .catch((value) => {
        if (!abort.signal.aborted) setDetailError(explain(value));
      });
    return () => abort.abort();
  }, [api, target]);

  const userMap = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );
  const rows = data?.requests ?? [];

  const open = (request: PendingRequest) => {
    setTarget(request);
    setAmount("");
    setNote("");
    setResolveError("");
  };
  const resolve = async () => {
    if (!target) return;
    setBusy(true);
    setResolveError("");
    try {
      await api.request(
        `/admin/wallet/requests/${encodeURIComponent(target.id)}/resolve`,
        "POST",
        { amountYuan: amount, note },
      );
      setTarget(undefined);
      refresh((value) => value + 1);
      notify("扣款已核对，剩余预占已释放");
    } catch (value) {
      setResolveError(
        "核对结果未确认，请刷新查看；不要改用新请求。" + explain(value),
      );
      problem(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminPage
      title="扣费核对"
      subtitle="只处理用量未知的请求；确认依据后结算，已完成请求不会重复扣款。"
      error={error || undefined}
      onRetry={() => refresh((value) => value + 1)}
      actions={
        <Button
          size="sm"
          leftIcon={<RefreshCw size={14} />}
          isDisabled={busy}
          onClick={() => refresh((value) => value + 1)}
        >
          刷新队列
        </Button>
      }
    >
      <Flex gap={2} align="center" flexWrap="wrap" mb={2}>
        <Box position="relative" flex="1 1 240px" maxW="380px">
          <Box
            position="absolute"
            left={2.5}
            top="50%"
            transform="translateY(-50%)"
            color="muted"
            pointerEvents="none"
          >
            <Search size={14} />
          </Box>
          <Input
            aria-label="搜索全部用户、模型或请求编号"
            placeholder="搜索全部用户、模型或请求编号"
            value={query}
            pl={8}
            size="sm"
            bg="surface"
            onChange={(event) => update({ q: event.target.value, offset: 0 }, true)}
          />
        </Box>
        <HStack spacing={1}>
          {[
            ["all", "全部"],
            ["24h", "超过24小时"],
          ].map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={ageFilter === value ? "tint" : "ghost"}
              onClick={() => update({ age: value === "all" ? undefined : value, offset: 0 }, true)}
            >
              {label}
            </Button>
          ))}
        </HStack>
      </Flex>
      <RefreshMeta at={data?.sampledAt} />
      <Text mt={2} mb={3} fontSize="11.5px" color="muted">
        共 {data?.total ?? 0} 笔 · 当前第 {Math.floor(offset / 50) + 1} 页 ·{" "}
        {data?.requests[0]
          ? `最早 ${age(data.requests[0].createdAt)}`
          : "当前页为空"}
        。搜索和时长筛选作用于全部待核对请求。
      </Text>

      {loading && !data ? (
        <Flex justify="center" py={14}>
          <Spinner />
        </Flex>
      ) : error && !data ? (
        <Card>
          <EmptyState
            title="队列读取失败"
            description="已有数据可能过期，请重试；不要根据旧页面重复核对。"
            action={
              <Button
                size="sm"
                onClick={() => refresh((value) => value + 1)}
              >
                重试
              </Button>
            }
          />
        </Card>
      ) : data && !data.requests.length ? (
        <Card>
          <EmptyState
            title="当前没有待核对请求"
            description="未知用量都已核对完成。列表变化后需要刷新。"
          />
        </Card>
      ) : (
        <Card overflowX="auto">
          <Table size="sm" minW="820px">
            <Thead>
              <Tr>
                <Th textTransform="none" fontSize="10.5px" color="muted">时间</Th>
                <Th textTransform="none" fontSize="10.5px" color="muted">用户</Th>
                <Th textTransform="none" fontSize="10.5px" color="muted">模型</Th>
                <Th textTransform="none" fontSize="10.5px" color="muted">预占</Th>
                <Th textTransform="none" fontSize="10.5px" color="muted">备注</Th>
                <Th textTransform="none" fontSize="10.5px" color="muted">操作</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((row) => {
                const user = userMap.get(row.userId);
                return (
                  <Tr key={row.id} _hover={{ bg: "surfaceHover" }}>
                    <Td whiteSpace="nowrap">
                      <Text fontSize="12px">
                        {new Date(row.createdAt).toLocaleString("zh-CN")}
                      </Text>
                      <Pill tone={requestAgeTone(row.createdAt)}>
                        {age(row.createdAt)}
                      </Pill>
                    </Td>
                    <Td>
                      <Text fontSize="12px" fontWeight={550}>
                        {user?.name ?? row.userId}
                      </Text>
                      <Text fontSize="10.5px" color="muted" fontFamily="mono">
                        {row.userId}
                      </Text>
                    </Td>
                    <Td fontSize="12px">{row.modelName}</Td>
                    <Td fontSize="12px" whiteSpace="nowrap">
                      {money(row.reserved)}
                    </Td>
                    <Td fontSize="11.5px" color="ink2" maxW="260px">
                      <Text noOfLines={2}>{row.note || "—"}</Text>
                    </Td>
                    <Td>
                      <Button size="xs" onClick={() => open(row)}>
                        核对
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
          {!rows.length && (
            <EmptyState
              title="当前页没有匹配的请求"
              description="清除搜索或时长筛选后重试。"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => update({ q: undefined, age: undefined }, true)}
                >
                  清除筛选
                </Button>
              }
            />
          )}
        </Card>
      )}

      <HStack mt={3} spacing={2}>
        <Button
          size="sm"
          variant="outline"
          isDisabled={offset === 0 || loading}
          onClick={() => update({ offset: Math.max(0, offset - 50) })}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          isDisabled={!data?.nextOffset || loading}
          onClick={() => {
            if (data?.nextOffset) update({ offset: data.nextOffset });
          }}
        >
          下一页
        </Button>
      </HStack>

      <Drawer
        isOpen={!!target}
        placement="right"
        onClose={() => {
          if (!busy) setTarget(undefined);
        }}
      >
        <DrawerOverlay />
        <DrawerContent maxW={{ base: "100%", md: "480px" }}>
          <DrawerCloseButton isDisabled={busy} aria-label="关闭核对" />
          <DrawerHeader fontSize="16px">核对扣款</DrawerHeader>
          <DrawerBody>
            {target && (
              <Flex direction="column" gap={4}>
                <Card p={4}>
                  <Text fontSize="12.5px" fontWeight={600}>
                    {target.modelName}
                  </Text>
                  <Text mt={1} fontSize="11.5px" color="muted" fontFamily="mono" overflowWrap="anywhere">
                    {target.id}
                  </Text>
                  <Text mt={2} fontSize="12px" color="ink2">
                    {new Date(target.createdAt).toLocaleString("zh-CN")} ·{" "}
                    {age(target.createdAt)}
                  </Text>
                  <Text mt={1.5} fontSize="12px" color="ink2">
                    预占上限 {money(target.reserved)}
                  </Text>
                  <Text mt={1.5} fontSize="11.5px" color="muted">
                    {target.note || "未填写备注"}
                  </Text>
                </Card>

                <Card p={4}>
                  <Flex align="center" gap={2} mb={2}>
                    <Text fontSize="12.5px" fontWeight={600} flex={1}>
                      {userMap.get(target.userId)?.name ?? target.userId}
                    </Text>
                    {userMap.get(target.userId)?.disabled ? (
                      <Pill tone="red">已停用</Pill>
                    ) : null}
                    {details && (
                      <Pill tone={details.reserved > 0 ? "amber" : "teal"}>
                        {details.reserved > 0 ? "有预占" : "无预占"}
                      </Pill>
                    )}
                  </Flex>
                  {detailError ? (
                    <ErrorNote message={`用户额度读取失败：${detailError}`} />
                  ) : !details ? (
                    <Spinner size="sm" />
                  ) : (
                    <>
                      <Text fontSize="12px" color="ink2">
                        可用 {money(details.available)} · 预占{" "}
                        {money(details.reserved)} · 余额 {money(details.balance)}
                      </Text>
                      <Text mt={1} fontSize="11.5px" color="muted">
                        {details.plusUntil && details.plusUntil > Date.now()
                          ? `Plus 至 ${new Date(details.plusUntil).toLocaleDateString("zh-CN")}`
                          : "普通用户"}
                      </Text>
                      <Button
                        as={RouteLink}
                        to={`/admin/users?user=${encodeURIComponent(target.userId)}`}
                        mt={2}
                        display="inline-flex"
                        variant="link"
                        size="xs"
                        color="brand.600"
                      >
                        打开用户详情 →
                      </Button>
                    </>
                  )}
                </Card>

                <RequestEvidence key={target.id} id={target.id} />
                {resolveError && <ErrorNote message={resolveError} />}
                <FormControl>
                  <FormLabel fontSize="12px">实际扣款（元）</FormLabel>
                  <Input
                    aria-label="核对扣款金额"
                    type="number"
                    min={0}
                    max={target.reserved / 1000000}
                    step="0.000001"
                    required
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                  <Text mt={1} fontSize="11px" color="muted">
                    最多 {money(target.reserved)}；确认无消费填 0。
                  </Text>
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="12px">核对依据与备注</FormLabel>
                  <Input
                    aria-label="核对依据与备注"
                    required
                    maxLength={200}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </FormControl>
                <Text fontSize="11px" color="muted" lineHeight={1.6}>
                  提交会扣除确认金额并释放剩余预占；重复提交相同金额和备注不会重复扣款。
                </Text>
              </Flex>
            )}
          </DrawerBody>
          <DrawerFooter>
            <Button
              variant="ghost"
              mr={2}
              isDisabled={busy}
              onClick={() => setTarget(undefined)}
            >
              取消
            </Button>
            <Button
              isLoading={busy}
              isDisabled={!note.trim() || !amount}
              onClick={() => void resolve()}
            >
              确认扣款并释放剩余预占
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </AdminPage>
  );
}
