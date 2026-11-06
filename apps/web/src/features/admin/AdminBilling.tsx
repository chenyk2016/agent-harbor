/** 计费设置：全局赠送规则、批量赠送和计费状态；单个用户的余额与 Plus 在用户详情。 */
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Input,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { RefreshCw, Wallet } from "lucide-react";
import { Link as RouteLink } from "react-router";
import { useAdmin } from "./context.js";
import { explain } from "../../state/workspace.js";
import { money } from "../wallet/WalletPanel.js";
import {
  AdminPage,
  Card,
  ErrorNote,
  SectionTitle,
  StatTile,
} from "./ui.js";
import type { AdminDeploymentSummary, WalletAdminData } from "./types.js";

export function AdminBilling() {
  const { api, problem, notify } = useAdmin();
  const [data, setData] = useState<WalletAdminData>();
  const [models, setModels] = useState<AdminDeploymentSummary[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, refresh] = useState(0);
  const [signup, setSignup] = useState("");
  const [plus, setPlus] = useState("");
  const [savingRules, setSavingRules] = useState(false);
  const [rulesError, setRulesError] = useState("");
  const [mode, setMode] = useState<"selected" | "all">("selected");
  const [userQuery, setUserQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{
    id: string;
    userIds: string[];
    amountYuan: string;
    note: string;
  }>();
  const [giftBusy, setGiftBusy] = useState(false);
  const [giftError, setGiftError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void Promise.allSettled([
      api.request<WalletAdminData>("/admin/wallet", "GET", undefined, abort.signal),
      api
        .request<{ enabled: boolean }>("/llm/models", "GET", undefined, abort.signal)
        .then(async (catalog) =>
          catalog.enabled
            ? api.request<{ deployments: AdminDeploymentSummary[] }>(
                "/admin/llm",
                "GET",
                undefined,
                abort.signal,
              )
            : undefined,
        ),
    ]).then(([wallet, llm]) => {
      if (abort.signal.aborted) return;
      if (wallet.status === "fulfilled") {
        setData(wallet.value);
        setSignup(String(wallet.value.settings.signupMicro / 1000000));
        setPlus(String(wallet.value.settings.plusMicro / 1000000));
      } else {
        setError(explain(wallet.reason));
        problem(wallet.reason);
      }
      if (llm.status === "fulfilled") setModels(llm.value?.deployments ?? []);
      setLoading(false);
    });
    return () => abort.abort();
  }, [api, problem, version]);

  const activeUsers = useMemo(
    () =>
      (data?.users ?? [])
        .filter((user) => !user.disabled)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [data],
  );
  const filteredUsers = useMemo(() => {
    const query = userQuery.trim().toLowerCase();
    if (!query) return activeUsers;
    return activeUsers.filter((user) =>
      `${user.name} ${user.id}`.toLowerCase().includes(query),
    );
  }, [activeUsers, userQuery]);
  const unpriced = models?.filter((model) => model.enabled && !model.price) ?? [];
  const invalidate = () => {
    setPreview(undefined);
    setGiftError("");
  };
  const recipients = useMemo(() => {
    if (mode === "all") return activeUsers;
    const user = activeUsers.find((item) => item.id === selected);
    return user ? [user] : [];
  }, [mode, activeUsers, selected]);
  const total = Number(amount) * recipients.length;

  const saveRules = async () => {
    setSavingRules(true);
    setRulesError("");
    try {
      await api.request("/admin/wallet/settings", "PUT", {
        signupYuan: signup,
        plusYuan: plus,
      });
      notify("赠送规则已保存");
      refresh((value) => value + 1);
    } catch (value) {
      setRulesError(explain(value));
      problem(value);
    } finally {
      setSavingRules(false);
    }
  };
  const confirmGift = async () => {
    if (!preview) return;
    setGiftBusy(true);
    setGiftError("");
    try {
      await api.request("/admin/wallet/gifts", "POST", preview);
      notify(`已向 ${preview.userIds.length} 位用户发放赠送`);
      setPreview(undefined);
      setAmount("");
      setNote("");
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

  return (
    <AdminPage
      title="计费设置"
      subtitle="全局赠送规则与批量赠送；单个用户的余额和 Plus 在用户详情处理。"
      error={error || undefined}
      onRetry={() => refresh((value) => value + 1)}
      actions={
        <Button
          size="sm"
          leftIcon={<RefreshCw size={14} />}
          onClick={() => refresh((value) => value + 1)}
        >
          刷新
        </Button>
      }
    >
      {loading && !data ? (
        <Flex justify="center" py={14}>
          <Spinner />
        </Flex>
      ) : data ? (
        <Stack spacing={5}>
          {!data.enabled && (
            <ErrorNote
              tone="warning"
              message="余额控制尚未启用，请配置计费入口后再使用赠送和核对。"
            />
          )}

          <Box>
            <SectionTitle
              title="赠送规则"
              detail="0 关闭相应赠送；修改只影响后续发放，不改历史。"
            />
            <Card p={4}>
              <SimpleGrid columns={{ base: 1, md: 2 }} gap={4}>
                <FormControl>
                  <FormLabel fontSize="12px">新用户注册赠送（元）</FormLabel>
                  <Input
                    aria-label="注册赠送金额"
                    type="number"
                    min={0}
                    step="0.000001"
                    value={signup}
                    onChange={(event) => setSignup(event.target.value)}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="12px">Plus 每月赠送（元）</FormLabel>
                  <Input
                    aria-label="Plus月度赠送金额"
                    type="number"
                    min={0}
                    step="0.000001"
                    value={plus}
                    onChange={(event) => setPlus(event.target.value)}
                  />
                </FormControl>
              </SimpleGrid>
              <Text mt={3} fontSize="11.5px" color="muted" lineHeight={1.7}>
                Plus 按上海自然月发放，额度累计不清零；已有用户不追发注册赠送。
              </Text>
              {rulesError && (
                <Box mt={3}>
                  <ErrorNote message={rulesError} />
                </Box>
              )}
              <Button
                mt={3}
                size="sm"
                isLoading={savingRules}
                isDisabled={!signup || !plus}
                onClick={() => void saveRules()}
              >
                保存赠送规则
              </Button>
            </Card>
          </Box>

          <Box>
            <SectionTitle
              title="手动赠送"
              detail="先预览人数、金额和名单，再确认；批次号用于防止重复入账。"
            />
            <Card p={4}>
              <Flex gap={1} mb={3}>
                {[
                  ["selected", "指定用户"],
                  ["all", "所有当前未停用用户"],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={mode === value ? "tint" : "ghost"}
                    onClick={() => {
                      setMode(value as "selected" | "all");
                      setSelected("");
                      setUserQuery("");
                      invalidate();
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </Flex>
              {mode === "selected" ? (
                <>
                  <Input
                    aria-label="搜索赠送用户"
                    placeholder="搜索用户名称或 ID"
                    size="sm"
                    value={userQuery}
                    onChange={(event) => {
                      setUserQuery(event.target.value);
                      setSelected("");
                      invalidate();
                    }}
                  />
                  <Box
                    mt={2}
                    maxH="180px"
                    overflowY="auto"
                    border="1px solid"
                    borderColor="line"
                    borderRadius="9px"
                  >
                    {filteredUsers.length ? (
                      filteredUsers.map((user) => (
                        <Box
                          as="button"
                          type="button"
                          key={user.id}
                          w="100%"
                          textAlign="left"
                          px={3}
                          py={2}
                          borderTop="1px solid"
                          borderColor="line"
                          _first={{ borderTop: 0 }}
                          bg={selected === user.id ? "brand.50" : "surface"}
                          color={selected === user.id ? "brand.700" : "ink"}
                          fontSize="12px"
                          onClick={() => {
                            setSelected(user.id);
                            invalidate();
                          }}
                        >
                          <Text fontWeight={550}>{user.name}</Text>
                          <Text fontSize="10.5px" color="muted" fontFamily="mono">
                            {user.id} · 可用 {money((user.balance ?? 0) - (user.reserved ?? 0))}
                          </Text>
                        </Box>
                      ))
                    ) : (
                      <Text px={3} py={4} fontSize="12px" color="muted">
                        没有匹配的未停用用户
                      </Text>
                    )}
                  </Box>
                </>
              ) : (
                <Text fontSize="12px" color="ink2" lineHeight={1.7}>
                  将覆盖 {activeUsers.length} 位未停用用户：
                  {activeUsers
                    .slice(0, 8)
                    .map((user) => user.name)
                    .join("、")}
                  {activeUsers.length > 8 ? "…" : ""}
                </Text>
              )}
              <SimpleGrid columns={{ base: 1, md: 2 }} gap={3} mt={3}>
                <FormControl>
                  <FormLabel fontSize="12px">每人金额（元）</FormLabel>
                  <Input
                    aria-label="手动赠送金额"
                    type="number"
                    min="0.000001"
                    step="0.000001"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      invalidate();
                    }}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="12px">赠送备注</FormLabel>
                  <Input
                    aria-label="赠送备注"
                    maxLength={200}
                    value={note}
                    onChange={(event) => {
                      setNote(event.target.value);
                      invalidate();
                    }}
                  />
                </FormControl>
              </SimpleGrid>
              {giftError && (
                <Box mt={3}>
                  <ErrorNote message={giftError} />
                </Box>
              )}
              <Button
                mt={3}
                size="sm"
                variant="outline"
                isDisabled={
                  giftBusy ||
                  !amount ||
                  Number(amount) <= 0 ||
                  !note.trim() ||
                  !recipients.length
                }
                onClick={() => {
                  setPreview({
                    id: crypto.randomUUID(),
                    userIds: recipients.map((user) => user.id).sort(),
                    amountYuan: amount,
                    note: note.trim(),
                  });
                  setGiftError("");
                }}
              >
                预览赠送
              </Button>
              {preview && (
                <Box
                  mt={3}
                  p={3}
                  border="1px solid"
                  borderColor="line"
                  borderRadius="9px"
                  bg="sunken"
                >
                  <Text fontSize="12px" fontWeight={600}>
                    将向 {preview.userIds.length} 位用户各赠送 ¥{preview.amountYuan}
                    ，合计 ¥{total.toFixed(6)}
                  </Text>
                  <Text mt={1} fontSize="11px" color="muted" overflowWrap="anywhere">
                    名单：
                    {data.users
                      .filter((user) => preview.userIds.includes(user.id))
                      .map((user) => `${user.name}(${user.id})`)
                      .join("、")}
                  </Text>
                  <Button
                    mt={2.5}
                    size="sm"
                    isLoading={giftBusy}
                    onClick={() => void confirmGift()}
                  >
                    确认本批赠送
                  </Button>
                  <Text mt={1.5} fontSize="10.5px" color="muted">
                    响应不明时保留本批次，重试不会重复入账；请勿重新预览同一批赠送。
                  </Text>
                </Box>
              )}
            </Card>
          </Box>

          <Box>
            <SectionTitle title="计费状态" detail="只展示当前配置，不代表供应商实时健康。" />
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={3}>
              <StatTile
                label="余额控制"
                value={data.enabled ? "已启用" : "未启用"}
                detail={
                  data.enabled
                    ? "请求按平台人民币单价预占和结算"
                    : "需要部署配置后才能生效"
                }
              />
              <Card p={4}>
                <Flex align="center" gap={2}>
                  <Wallet size={15} color="var(--ah-muted)" />
                  <Text fontSize="12px" fontWeight={600} flex={1}>
                    未定价模型
                  </Text>
                  <Text fontSize="22px" fontWeight={650}>
                    {models ? unpriced.length : "—"}
                  </Text>
                </Flex>
                <Text mt={2} fontSize="11.5px" color="muted" lineHeight={1.6}>
                  未配置价格的模型不能扣费使用。
                </Text>
                <Button
                  as={RouteLink}
                  to="/admin/models?filter=unpriced"
                  mt={2}
                  size="xs"
                  variant="link"
                  color="brand.600"
                >
                  去定价 →
                </Button>
              </Card>
            </SimpleGrid>
          </Box>
        </Stack>
      ) : null}
    </AdminPage>
  );
}
