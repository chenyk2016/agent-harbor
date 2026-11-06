/** 用户管理：左侧列表、右侧详情；额度、Plus、赠送和停用都在选中用户上下文中完成。 */
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import {
  ArrowLeft,
  Copy,
  Gift,
  Pencil,
  Power,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import { useSearchParams, Link as RouteLink } from "react-router";
import { useAdmin } from "./context.js";
import { explain } from "../../state/workspace.js";
import {
  WalletLedger,
  WalletSummary,
  WalletUsage,
  money,
  type WalletData,
} from "../wallet/WalletPanel.js";
import { Select } from "../../shared/select.js";
import { Pill } from "../../shared/ui.js";
import {
  AdminPage,
  Card,
  EmptyState,
  ErrorNote,
  SectionTitle,
  UserStatus,
  bytesToInput,
  humanBytes,
  inputToBytes,
} from "./ui.js";
import type { AdminUser, WalletAdminData, WalletAdminUser } from "./types.js";
import {
  defaultLimits,
  type UserLimits,
} from "../../../../../src/service/limits/policy.js";

export function AdminUsers() {
  const { api, userId: adminId, problem, notify } = useAdmin();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("user") ?? "";
  const query = params.get("q") ?? "";
  const status = params.get("status") ?? "all";
  const [users, setUsers] = useState<AdminUser[]>();
  const [wallet, setWallet] = useState<WalletAdminData>();
  const [error, setError] = useState("");
  const [walletError, setWalletError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, refresh] = useState(0);

  const update = (values: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setWalletError("");
    void Promise.allSettled([
      api.request<AdminUser[]>("/admin/users", "GET", undefined, abort.signal),
      api.request<WalletAdminData>("/admin/wallet", "GET", undefined, abort.signal),
    ]).then(([accounts, balances]) => {
      if (abort.signal.aborted) return;
      if (accounts.status === "fulfilled") setUsers(accounts.value);
      else {
        setError(explain(accounts.reason));
        problem(accounts.reason);
      }
      if (balances.status === "fulfilled") setWallet(balances.value);
      else setWalletError(explain(balances.reason));
      setLoading(false);
    });
    return () => abort.abort();
  }, [api, problem, version]);

  const walletMap = useMemo(
    () => new Map((wallet?.users ?? []).map((user) => [user.id, user])),
    [wallet],
  );
  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (users ?? [])
      .filter(
        (user) =>
          (!text || `${user.name} ${user.id}`.toLowerCase().includes(text)) &&
          (status === "all" || Boolean(user.disabled) === (status === "disabled")),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [users, query, status]);
  const selected = users?.find((user) => user.id === selectedId);
  const selectedWallet = walletMap.get(selectedId);
  const counts = {
    all: users?.length ?? 0,
    active: users?.filter((user) => !user.disabled).length ?? 0,
    disabled: users?.filter((user) => user.disabled).length ?? 0,
  };

  return (
    <AdminPage
      title="用户"
      subtitle="选中账号后在右侧处理额度、Plus、赠送和停用。"
      error={error || undefined}
      onRetry={() => refresh((value) => value + 1)}
      fill
      actions={
        <Button
          size="sm"
          leftIcon={<RefreshCw size={14} />}
          onClick={() => refresh((value) => value + 1)}
        >
          刷新用户
        </Button>
      }
    >
      {walletError && (
        <Box mb={3} flexShrink={0}>
          <ErrorNote
            message={`余额数据读取失败：${walletError}`}
            onRetry={() => refresh((value) => value + 1)}
          />
        </Box>
      )}
      <Flex flex={1} minH={0} gap={4} direction={{ base: "column", app: "row" }}>
        <Card
          flex={{ base: 1, app: "0 0 380px" }}
          w={{ base: "100%", app: "380px" }}
          display={{
            base: selectedId ? "none" : "flex",
            app: "flex",
          }}
          flexDirection="column"
          minH={0}
          overflow="hidden"
          flexShrink={0}
        >
          <Box p={3} borderBottom="1px solid" borderColor="line">
            <Box position="relative">
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
                aria-label="搜索用户"
                placeholder="搜索用户名称或 ID"
                value={query}
                pl={8}
                size="sm"
                onChange={(event) => update({ q: event.target.value })}
              />
            </Box>
            <HStack spacing={1} mt={2}>
              {[
                ["all", `全部 ${counts.all}`],
                ["active", `正常 ${counts.active}`],
                ["disabled", `停用 ${counts.disabled}`],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  size="xs"
                  variant={status === value ? "tint" : "ghost"}
                  onClick={() =>
                    update({ status: value === "all" ? undefined : value })
                  }
                >
                  {label}
                </Button>
              ))}
            </HStack>
          </Box>
          <Box flex={1} minH={0} overflowY="auto">
            {loading && !users ? (
              <Flex justify="center" py={10}>
                <Spinner />
              </Flex>
            ) : visible.length ? (
              visible.map((user) => {
                const balance = walletMap.get(user.id);
                const available = (balance?.balance ?? 0) - (balance?.reserved ?? 0);
                const plus = (balance?.plusUntil ?? 0) > Date.now();
                const active = user.id === selectedId;
                return (
                  <Box
                    as="button"
                    type="button"
                    key={user.id}
                    w="100%"
                    textAlign="left"
                    px={3}
                    py={2.5}
                    borderTop="1px solid"
                    borderColor="line"
                    _first={{ borderTop: 0 }}
                    bg={active ? "brand.50" : "surface"}
                    _hover={{ bg: active ? "brand.50" : "surfaceHover" }}
                    onClick={() => update({ user: user.id })}
                  >
                    <Flex align="center" gap={2.5}>
                      <Flex
                        w="28px"
                        h="28px"
                        borderRadius="8px"
                        bg={active ? "brand.100" : "sunken"}
                        color={active ? "brand.700" : "ink2"}
                        align="center"
                        justify="center"
                        fontSize="12px"
                        fontWeight={600}
                        flexShrink={0}
                      >
                        {user.name.slice(0, 1).toUpperCase()}
                      </Flex>
                      <Box flex={1} minW={0}>
                        <HStack spacing={1.5} minW={0}>
                          <Text fontSize="12.5px" fontWeight={600} noOfLines={1}>
                            {user.name}
                          </Text>
                          <UserStatus disabled={user.disabled} />
                          {plus && <Pill tone="blue">Plus</Pill>}
                        </HStack>
                        <Text fontSize="10.5px" color="muted" fontFamily="mono" noOfLines={1}>
                          {user.id}
                        </Text>
                        {wallet?.enabled && (
                          <Text fontSize="10.5px" color="muted">
                            可用 {money(available)}
                            {(balance?.reserved ?? 0) > 0
                              ? ` · 预占 ${money(balance?.reserved ?? 0)}`
                              : ""}
                          </Text>
                        )}
                      </Box>
                    </Flex>
                  </Box>
                );
              })
            ) : (
              <EmptyState
                title={users?.length ? "没有匹配的用户" : "还没有用户"}
                description={
                  users?.length
                    ? "清除搜索或状态筛选后重试。"
                    : "用户首次登录后会出现在这里。"
                }
              />
            )}
          </Box>
          <Box px={3} py={2} borderTop="1px solid" borderColor="line">
            <Text fontSize="10.5px" color="muted">
              显示 {visible.length} / 共 {counts.all} 位；最多读取 1000 位
            </Text>
          </Box>
        </Card>

        <Box
          flex={1}
          minW={0}
          minH={0}
          overflowY="auto"
          display={{
            base: selectedId ? "block" : "none",
            app: "block",
          }}
        >
          {selected ? (
            <UserDetail
              api={api}
              user={selected}
              adminId={adminId}
              walletUser={selectedWallet}
              notify={notify}
              problem={problem}
              onBack={() => update({ user: undefined })}
              onChanged={() => refresh((value) => value + 1)}
            />
          ) : selectedId ? (
            <Card>
              <EmptyState
                icon={<UserRound size={22} />}
                title="找不到这个用户"
                description="链接中的用户可能已被移除，或列表尚未加载完成。"
                action={
                  <Button size="sm" variant="outline" onClick={() => update({ user: undefined })}>
                    返回用户列表
                  </Button>
                }
              />
            </Card>
          ) : (
            <Card h="full" minH="260px">
              <EmptyState
                icon={<UserRound size={22} />}
                title="从左侧选择一位用户"
                description="选中后可以查看余额、流水、模型用量、Plus 和资源额度。"
              />
            </Card>
          )}
        </Box>
      </Flex>
    </AdminPage>
  );
}

function UserDetail({
  api,
  user,
  adminId,
  walletUser,
  notify,
  problem,
  onBack,
  onChanged,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  user: AdminUser;
  adminId: string;
  walletUser?: WalletAdminUser;
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<WalletData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);
  const [tab, setTab] = useState<"overview" | "ledger" | "limits">("overview");
  const [limits, setLimits] = useState<UserLimits>({
    ...defaultLimits,
    ...(user.limits ? JSON.parse(user.limits) : {}),
  });
  const initialBytes = bytesToInput(limits.workspaceBytes);
  const [workspaceValue, setWorkspaceValue] = useState(String(initialBytes.value));
  const [workspaceUnit, setWorkspaceUnit] = useState<"MiB" | "GiB">(
    initialBytes.unit,
  );
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitError, setLimitError] = useState("");
  const [giftOpen, setGiftOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [giftBatch, setGiftBatch] = useState("");
  const [giftBusy, setGiftBusy] = useState(false);
  const [giftError, setGiftError] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState("");
  const [plusUntil, setPlusUntil] = useState("");
  const [plusBusy, setPlusBusy] = useState(false);
  const [plusError, setPlusError] = useState("");
  const [cancelPlusOpen, setCancelPlusOpen] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void api
      .request<WalletData>(
        `/admin/wallet/users/${encodeURIComponent(user.id)}`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setData(value);
      })
      .catch((value) => {
        if (!abort.signal.aborted) setError(explain(value));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, user.id, version]);

  useEffect(() => {
    setTab("overview");
  }, [user.id]);

  useEffect(() => {
    const parsed = {
      ...defaultLimits,
      ...(user.limits ? JSON.parse(user.limits) : {}),
    };
    setLimits(parsed);
    const next = bytesToInput(parsed.workspaceBytes);
    setWorkspaceValue(String(next.value));
    setWorkspaceUnit(next.unit);
  }, [user.limits]);

  const saveLimits = async () => {
    setSavingLimits(true);
    setLimitError("");
    try {
      await api.request(`/admin/users/${encodeURIComponent(user.id)}`, "PATCH", {
        limits: {
          ...limits,
          workspaceBytes: inputToBytes(
            Number(workspaceValue),
            workspaceUnit,
          ),
        },
      });
      notify("用户额度已保存");
      onChanged();
      refresh((value) => value + 1);
    } catch (value) {
      setLimitError(explain(value));
      problem(value);
    } finally {
      setSavingLimits(false);
    }
  };
  const gift = async () => {
    setGiftBusy(true);
    setGiftError("");
    const id = giftBatch || crypto.randomUUID();
    setGiftBatch(id);
    try {
      await api.request("/admin/wallet/gifts", "POST", {
        id,
        userIds: [user.id],
        amountYuan: amount,
        note: note.trim(),
      });
      notify(`已向 ${user.name} 赠送 ¥${amount}`);
      setGiftOpen(false);
      setGiftBatch("");
      setAmount("");
      setNote("");
      onChanged();
      refresh((value) => value + 1);
    } catch (value) {
      setGiftError(
        "响应不明时保留本批次，重试不会重复入账；请勿重新预览同一批赠送。" +
          explain(value),
      );
      problem(value);
    } finally {
      setGiftBusy(false);
    }
  };
  const toggleDisabled = async () => {
    setDisableBusy(true);
    setDisableError("");
    try {
      await api.request(`/admin/users/${encodeURIComponent(user.id)}`, "PATCH", {
        disabled: !user.disabled,
      });
      notify(user.disabled ? "账号已重新启用" : "账号已停用");
      setDisableOpen(false);
      onChanged();
    } catch (value) {
      setDisableError(explain(value));
      problem(value);
    } finally {
      setDisableBusy(false);
    }
  };
  const setPlus = async (until: number | null) => {
    setPlusBusy(true);
    setPlusError("");
    try {
      await api.request(
        `/admin/wallet/users/${encodeURIComponent(user.id)}/plus`,
        "PUT",
        { until },
      );
      notify(until === null ? "已取消 Plus" : "Plus 到期时间已设置");
      setCancelPlusOpen(false);
      onChanged();
      refresh((value) => value + 1);
    } catch (value) {
      setPlusError(explain(value));
      problem(value);
    } finally {
      setPlusBusy(false);
    }
  };
  const copyId = () => {
    void navigator.clipboard
      .writeText(user.id)
      .then(() => notify("已复制用户 ID"))
      .catch(() => notify("复制未完成，请手动选择。"));
  };
  const bytes = inputToBytes(Number(workspaceValue) || 0, workspaceUnit);

  return (
    <Stack spacing={3}>
      <Card p={4}>
        <Flex align="flex-start" gap={3} flexWrap="wrap">
          <IconButton
            display={{ base: "inline-flex", app: "none" }}
            aria-label="返回用户列表"
            variant="ghost"
            size="sm"
            icon={<ArrowLeft size={17} />}
            onClick={onBack}
          />
          <Box flex={1} minW="200px">
            <HStack spacing={2} flexWrap="wrap">
              <Text fontSize="16px" fontWeight={650}>
                {user.name}
              </Text>
              <UserStatus disabled={user.disabled} />
              {walletUser?.plusUntil && walletUser.plusUntil > Date.now() && (
                <Pill tone="blue">Plus</Pill>
              )}
            </HStack>
            <HStack spacing={1} mt={1}>
              <Text fontSize="11px" color="muted" fontFamily="mono" overflowWrap="anywhere">
                {user.id}
              </Text>
              <Tooltip label="复制用户 ID">
                <IconButton
                  aria-label="复制用户 ID"
                  variant="ghost"
                  size="xs"
                  icon={<Copy size={12} />}
                  onClick={copyId}
                />
              </Tooltip>
            </HStack>
          </Box>
          <HStack spacing={1.5} flexWrap="wrap">
            <Button as={RouteLink} to={`/admin/activity?user=${encodeURIComponent(user.id)}`} size="sm" variant="outline">全部历史</Button>
            <Button as={RouteLink} to={`/admin/operations?user=${encodeURIComponent(user.id)}`} size="sm" variant="outline">任务与资源</Button>
            <Button
              size="sm"
              leftIcon={<Gift size={14} />}
              isDisabled={!!user.disabled}
              onClick={() => {
                setGiftOpen(true);
                setGiftBatch("");
                setGiftError("");
              }}
            >
              赠送
            </Button>
            <Button
              size="sm"
              variant="outline"
              leftIcon={<Pencil size={14} />}
              onClick={() => setTab("limits")}
            >
              编辑额度
            </Button>
            <Button
              size="sm"
              variant={user.disabled ? "outline" : "danger"}
              leftIcon={<Power size={14} />}
              isDisabled={user.id === adminId}
              onClick={() => {
                setDisableError("");
                setDisableOpen(true);
              }}
            >
              {user.disabled ? "重新启用" : "停用账号"}
            </Button>
            <Tooltip label="刷新用户详情">
              <IconButton
                aria-label="刷新用户详情"
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={15} />}
                onClick={() => refresh((value) => value + 1)}
              />
            </Tooltip>
          </HStack>
        </Flex>
      </Card>

      <Flex gap={1} flexWrap="wrap">
        {[
          ["overview", "概览"],
          ["ledger", "额度与流水"],
          ["limits", "资源额度"],
        ].map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={tab === value ? "tint" : "ghost"}
            onClick={() => setTab(value as typeof tab)}
          >
            {label}
          </Button>
        ))}
      </Flex>

      {tab === "limits" ? (
        <Card p={4}>
          <SectionTitle
            title="资源额度"
            detail="保存后用于后续资源申请，不主动停止已有任务；文件空间为软额度。"
          />
          <SimpleGrid columns={{ base: 1, md: 2 }} gap={3}>
            {[
              ["sessions", "保存会话数"],
              ["tasks", "同时执行任务数"],
              ["environments", "保留环境数"],
            ].map(([key, label]) => (
              <FormControl key={key}>
                <FormLabel fontSize="12px">{label}</FormLabel>
                <Input
                  aria-label={label}
                  type="number"
                  min={0}
                  step={1}
                  value={limits[key as "sessions" | "tasks" | "environments"]}
                  onChange={(event) =>
                    setLimits({
                      ...limits,
                      [key]: Number(event.target.value),
                    })
                  }
                />
              </FormControl>
            ))}
            <FormControl>
              <FormLabel fontSize="12px">工作文件软额度</FormLabel>
              <Flex gap={2}>
                <Input
                  aria-label="工作文件软额度"
                  type="number"
                  min={0}
                  step="0.01"
                  value={workspaceValue}
                  onChange={(event) => setWorkspaceValue(event.target.value)}
                  flex={1}
                />
                <Box w="92px">
                  <Select
                    ariaLabel="文件额度单位"
                    value={workspaceUnit}
                    onChange={(value) => {
                      const current = inputToBytes(
                        Number(workspaceValue) || 0,
                        workspaceUnit,
                      );
                      const next = bytesToInput(current);
                      setWorkspaceValue(String(next.value));
                      setWorkspaceUnit(value as "MiB" | "GiB");
                    }}
                    options={[
                      { value: "MiB", label: "MiB" },
                      { value: "GiB", label: "GiB" },
                    ]}
                    compact
                  />
                </Box>
              </Flex>
              <Text mt={1} fontSize="10.5px" color="muted">
                将保存为 {humanBytes(bytes)}（{bytes} 字节）
              </Text>
            </FormControl>
          </SimpleGrid>
          {limitError && (
            <Box mt={3}>
              <ErrorNote message={limitError} />
            </Box>
          )}
          <Button
            mt={3}
            size="sm"
            isLoading={savingLimits}
            onClick={() => void saveLimits()}
          >
            保存资源额度
          </Button>
        </Card>
      ) : loading && !data ? (
        <Flex justify="center" py={12}>
          <Spinner />
        </Flex>
      ) : error ? (
        <Card p={4}>
          <ErrorNote
            message={`额度读取失败：${error}`}
            onRetry={() => refresh((value) => value + 1)}
          />
        </Card>
      ) : data ? (
        tab === "overview" ? (
          <Stack spacing={4}>
            <Card p={4}>
              <WalletSummary data={data} />
            </Card>
            <Card p={4}>
              <SectionTitle title="Plus" detail="管理员开通的权益，不涉及付款；每月最多发放一次。" />
              {data.plusUntil && data.plusUntil > Date.now() ? (
                <Text fontSize="12px" mb={2}>
                  当前到期：{new Date(data.plusUntil).toLocaleString("zh-CN")}
                </Text>
              ) : (
                <Text fontSize="12px" color="muted" mb={2}>
                  当前未开通 Plus
                </Text>
              )}
              <Flex gap={2} flexWrap="wrap" align="end">
                <FormControl maxW="260px">
                  <FormLabel fontSize="12px">设置到期时间</FormLabel>
                  <Input
                    aria-label="Plus到期时间"
                    type="datetime-local"
                    value={plusUntil}
                    onChange={(event) => setPlusUntil(event.target.value)}
                  />
                </FormControl>
                <Button
                  size="sm"
                  isDisabled={!plusUntil}
                  isLoading={plusBusy}
                  onClick={() => void setPlus(new Date(plusUntil).getTime())}
                >
                  设置 Plus
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={!data.plusUntil}
                  onClick={() => setCancelPlusOpen(true)}
                >
                  取消 Plus
                </Button>
              </Flex>
              {plusError && (
                <Box mt={2}>
                  <ErrorNote message={plusError} />
                </Box>
              )}
            </Card>
            <Card p={4}>
              <SectionTitle
                title="最近收支"
                detail="只显示最近 5 条，完整记录在「额度与流水」。"
                children={
                  <Button size="xs" variant="ghost" onClick={() => setTab("ledger")}>
                    查看全部
                  </Button>
                }
              />
              <WalletLedger data={data} limit={5} />
            </Card>
            <Card p={4}>
              <SectionTitle
                title="最近模型用量"
                detail="只显示最近 5 次，完整记录在「额度与流水」。"
                children={
                  <Button size="xs" variant="ghost" onClick={() => setTab("ledger")}>
                    查看全部
                  </Button>
                }
              />
              <WalletUsage data={data} limit={5} />
            </Card>
          </Stack>
        ) : (
          <Stack spacing={4}>
            <Card p={4}>
              <SectionTitle title="收支明细" detail="最近 100 条" />
              <WalletLedger data={data} />
            </Card>
            <Card p={4}>
              <SectionTitle title="模型用量" detail="最近 100 次" />
              <WalletUsage data={data} />
            </Card>
          </Stack>
        )
      ) : null}

      <Modal
        isOpen={giftOpen}
        onClose={() => {
          if (!giftBusy) {
            setGiftOpen(false);
            setGiftBatch("");
          }
        }}
      >
        <ModalOverlay />
        <ModalContent mx={4} as="form" onSubmit={(event) => {
          event.preventDefault();
          void gift();
        }}>
          <ModalHeader>赠送 · {user.name}</ModalHeader>
          <ModalCloseButton isDisabled={giftBusy} />
          <ModalBody>
            <Stack spacing={3}>
              <FormControl>
                <FormLabel>赠送金额（元）</FormLabel>
                <Input
                  aria-label="单用户赠送金额"
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  required
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setGiftBatch("");
                  }}
                />
              </FormControl>
              <FormControl>
                <FormLabel>赠送备注</FormLabel>
                <Input
                  aria-label="单用户赠送备注"
                  maxLength={200}
                  required
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    setGiftBatch("");
                  }}
                />
              </FormControl>
              <Text fontSize="12px" color="ink2">
                将向 {user.name}（{user.id}）赠送 ¥{amount || "0"}。
              </Text>
              {giftError && <ErrorNote message={giftError} />}
              <Text fontSize="10.5px" color="muted">
                响应不明时保留本批次，重试不会重复入账。
              </Text>
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button
              type="submit"
              isLoading={giftBusy}
              isDisabled={!amount || Number(amount) <= 0 || !note.trim()}
            >
              确认赠送
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={disableOpen}
        onClose={() => {
          if (!disableBusy) setDisableOpen(false);
        }}
      >
        <ModalOverlay />
        <ModalContent mx={4}>
          <ModalHeader>
            {user.disabled ? "重新启用账号？" : "停用账号？"}
          </ModalHeader>
          <ModalCloseButton isDisabled={disableBusy} />
          <ModalBody>
            <Text>
              {user.name}（{user.id}）
            </Text>
            <Text mt={3} fontSize="12.5px" color="muted" lineHeight={1.7}>
              {user.disabled
                ? "重新启用不会恢复已撤销的密钥或登录；用户需要重新登录。"
                : "将撤销登录和密钥、停止该用户的任务及环境，并下线其公开应用；数据保留。"}
            </Text>
            {disableError && (
              <Box mt={3}>
                <ErrorNote message={disableError} />
              </Box>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="ghost"
              mr={2}
              isDisabled={disableBusy}
              onClick={() => setDisableOpen(false)}
            >
              取消
            </Button>
            <Button
              variant={user.disabled ? "solid" : "danger"}
              isLoading={disableBusy}
              onClick={() => void toggleDisabled()}
            >
              确认{user.disabled ? "启用" : "停用"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={cancelPlusOpen}
        onClose={() => {
          if (!plusBusy) setCancelPlusOpen(false);
        }}
      >
        <ModalOverlay />
        <ModalContent mx={4}>
          <ModalHeader>取消 Plus？</ModalHeader>
          <ModalCloseButton isDisabled={plusBusy} />
          <ModalBody>
            <Text fontSize="12.5px">
              将清除 {user.name} 的 Plus 到期时间，已发放余额保留。之后可以重新设置。
            </Text>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="ghost"
              mr={2}
              isDisabled={plusBusy}
              onClick={() => setCancelPlusOpen(false)}
            >
              保留 Plus
            </Button>
            <Button
              variant="danger"
              isLoading={plusBusy}
              onClick={() => void setPlus(null)}
            >
              确认取消
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Stack>
  );
}
