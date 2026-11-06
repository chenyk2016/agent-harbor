/** 平台总览：先展示会阻塞用户的待办，再看平台概况；各数据源独立失败。 */
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  SimpleGrid,
  Spinner,
  Text,
} from "@chakra-ui/react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { NavLink } from "react-router";
import { useAdmin } from "./context.js";
import { explain } from "../../state/workspace.js";
import {
  AdminPage,
  Card,
  EmptyState,
  ErrorNote,
  RefreshMeta,
  SectionTitle,
  StatTile,
  age,
} from "./ui.js";
import type {
  AdminDeploymentSummary,
  AdminUser,
  PendingQueue,
  Provider,
  WalletAdminData,
} from "./types.js";

type Loaded = {
  users?: AdminUser[];
  wallet?: WalletAdminData;
  queue?: PendingQueue;
  models?: AdminDeploymentSummary[];
  providers?: Provider[];
};
type Errors = Partial<Record<"users" | "wallet" | "queue" | "models", string>>;

export function AdminOverview() {
  const { api, problem } = useAdmin();
  const [data, setData] = useState<Loaded>({});
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(true);
  const [sampledAt, setSampledAt] = useState<number>();
  const [version, refresh] = useState(0);
  const [scope, setScope] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    const signal = abort.signal;
    setLoading(true);
    setErrors({});
    const request = <T,>(path: string) =>
      api.request<T>(path, "GET", undefined, signal);
    void Promise.allSettled([
      request<AdminUser[]>("/admin/users"),
      request<WalletAdminData>("/admin/wallet"),
      request<PendingQueue>("/admin/wallet/requests"),
      request<{ enabled: boolean }>("/llm/models").then(async (catalog) =>
        catalog.enabled
          ? request<{ providers: Provider[]; deployments: AdminDeploymentSummary[] }>("/admin/llm")
          : undefined,
      ),
    ]).then(async ([users, wallet, queue, llm]) => {
      if (signal.aborted) return;
      const next: Loaded = {};
      const nextErrors: Errors = {};
      if (users.status === "fulfilled") next.users = users.value;
      else {
        nextErrors.users = "账号数据读取失败";
        problem(users.reason);
      }
      if (wallet.status === "fulfilled") next.wallet = wallet.value;
      else {
        nextErrors.wallet = "钱包数据读取失败";
        problem(wallet.reason);
      }
      if (queue.status === "fulfilled") next.queue = queue.value;
      else {
        nextErrors.queue = "扣费队列读取失败";
        problem(queue.reason);
      }
      if (llm.status === "fulfilled") {
        next.models = llm.value?.deployments;
        next.providers = llm.value?.providers;
      } else {
        nextErrors.models = "模型配置读取失败";
        problem(llm.reason);
      }
      setData(next);
      setErrors(nextErrors);
      setSampledAt(Date.now());
      setLoading(false);
    });
    return () => abort.abort();
  }, [api, problem, version]);

  const users = data.users;
  const models = data.models;
  const pending = data.queue?.total ?? 0;
  const disabled = users?.filter((user) => user.disabled) ?? [];
  const unpriced = models?.filter((model) => model.enabled && !model.price) ?? [];
  const issues = models?.filter((model) => model.state !== "ready") ?? [];
  const oldest = data.queue?.requests[0];
  const actions = [
    pending > 0 && {
      key: "pending",
      icon: TriangleAlert,
      title: "扣费待核对",
      count: pending,
      detail: oldest
        ? `最早 ${age(oldest.createdAt)} · ${oldest.modelName}`
        : data.wallet?.reservationMode === "estimated" ? "未知用量保留该笔预占；其余可用余额仍可使用" : "未知用量保留预占，可能阻止该用户继续生成",
      to: "/admin/requests",
      color: "warnStrong",
      bg: "warnTint",
    },
    unpriced.length > 0 && {
      key: "unpriced",
      icon: Sparkles,
      title: "启用但未定价",
      count: unpriced.length,
      detail: unpriced
        .slice(0, 3)
        .map((model) => model.name)
        .join("、"),
      to: "/admin/models?filter=unpriced",
      color: "warnStrong",
      bg: "warnTint",
    },
    issues.length > 0 && {
      key: "issue",
      icon: TriangleAlert,
      title: "模型同步待确认",
      count: issues.length,
      detail: issues
        .slice(0, 3)
        .map((model) => model.name)
        .join("、"),
      to: "/admin/models?filter=issue",
      color: "warnStrong",
      bg: "warnTint",
    },

  ].filter(Boolean) as {
    key: string;
    title: string;
    count: number;
    detail: string;
    to: string;
    color: string;
    bg: string;
    icon: LucideIcon;
  }[];
  const hasSourceError = Object.keys(errors).length > 0;

  return (
    <AdminPage
      title="平台总览"
      subtitle="先处理会阻塞用户的事项，再看配置。"
      actions={
        <Button
          size="sm"
          leftIcon={<RefreshCw size={14} />}
          onClick={() => refresh((value) => value + 1)}
        >
          刷新总览
        </Button>
      }
    >
      <RefreshMeta at={sampledAt} />
      <Box mt={4}>
        <SectionTitle
          title="需要处理"
          detail="按影响排序；没有待办时这里会保持安静。"
        />
        {loading && !users && !models && !data.queue && !data.wallet ? (
          <Flex justify="center" py={10}>
            <Spinner />
          </Flex>
        ) : (
          <>
            {hasSourceError && (
              <HStack spacing={2} mb={3} flexWrap="wrap">
                {Object.entries(errors).map(([key, message]) => (
                  <Box key={key} flex="1 1 240px">
                    <ErrorNote
                      message={message}
                      onRetry={() => refresh((value) => value + 1)}
                    />
                  </Box>
                ))}
              </HStack>
            )}
            {actions.length ? (
              <SimpleGrid
                columns={{
                  base: 1,
                  md: Math.min(actions.length, 2),
                  xl: Math.min(actions.length, 4),
                }}
                spacing={3}
              >
                {actions.map(({ key, title, count, detail, to, color, bg, icon: Icon }) => (
                  <Card
                    key={key}
                    p={0}
                    _hover={{ borderColor: "lineStrong", shadow: "md" }}
                  >
                    <Box
                      as={NavLink}
                      to={to}
                      display="block"
                      p={4}
                      _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
                      borderRadius="12px"
                    >
                      <Flex align="center" gap={2}>
                        <Flex
                          w="28px"
                          h="28px"
                          borderRadius="8px"
                          bg={bg}
                          color={color}
                          align="center"
                          justify="center"
                          flexShrink={0}
                        >
                          <Icon size={15} />
                        </Flex>
                        <Text fontSize="12.5px" fontWeight={600} flex={1}>
                          {title}
                        </Text>
                        <Text fontSize="20px" fontWeight={650}>
                          {count}
                        </Text>
                      </Flex>
                      <Text mt={2.5} fontSize="11.5px" color="muted" noOfLines={2}>
                        {detail || "需要处理"}
                      </Text>
                      <Text mt={2} fontSize="11.5px" color="brand.600">
                        去处理 →
                      </Text>
                    </Box>
                  </Card>
                ))}
              </SimpleGrid>
            ) : hasSourceError ? (
              <Card><Text role="status">部分数据读取失败，当前状态未确认。请重试后再判断是否有待办。</Text></Card>
            ) : (
              <Card>
                <EmptyState
                  icon={<CheckCircle2 size={22} />}
                  title="当前没有需要处理的账号或配置问题"
                  description="当前可读取的扣费核对、定价和模型同步未发现待办；运行状态请查看运行状态页。"
                />
              </Card>
            )}
          </>
        )}
      </Box>

      <Box mt={6}>
        <SectionTitle title="平台概况" detail="只展示数据库中的配置和状态。" />
        <SimpleGrid columns={{ base: 1, md: 3 }} spacing={3}>
          <StatTile
            label="账号"
            value={users ? users.length : "—"}
            detail={
              users
                ? `正常 ${users.length - disabled.length} · 停用 ${disabled.length}`
                : errors.users
                  ? "读取失败"
                  : "读取中"
            }
          />
          <StatTile
            label="模型"
            value={models ? models.length : "—"}
            detail={
              models
                ? `启用 ${models.filter((model) => model.enabled).length} · 未定价 ${unpriced.length}`
                : errors.models
                  ? "读取失败或网关未接入"
                  : "读取中"
            }
          />
          <StatTile
            label="钱包控制"
            value={
              data.wallet ? (data.wallet.enabled ? "已启用" : "未启用") : "—"
            }
            detail={
              data.wallet?.enabled
                ? "余额与预占按平台价格结算"
                : errors.wallet
                  ? "读取失败"
                  : "未启用时余额规则不生效"
            }
          />
        </SimpleGrid>
      </Box>

      <Card mt={5} p={4}>
        <Flex align="center" gap={2}>
          <Wallet size={15} color="var(--ah-muted)" />
          <Text fontSize="12.5px" fontWeight={600} flex={1}>
            运行边界
          </Text>
          <Button
            size="xs"
            variant="ghost"
            rightIcon={scope ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            onClick={() => setScope((value) => !value)}
          >
            {scope ? "收起" : "查看"}
          </Button>
        </Flex>
        {scope && (
          <Text mt={2} fontSize="11.5px" color="muted" lineHeight={1.7}>
            这里展示账号、配置和扣费待办。运行状态页提供服务与网关存活检查、已记录的转发耗时和进程内存；存活不代表供应商模型可调用，美元成本观察也不等于供应商正式账单。
          </Text>
        )}
      </Card>
    </AdminPage>
  );
}
