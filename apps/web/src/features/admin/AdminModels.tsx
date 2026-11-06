/** 模型与网关：命名部署、不可变版本、价格版本、密钥轮换和审计。 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerHeader,
  DrawerOverlay,
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
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from "@chakra-ui/react";
import { Archive, KeyRound, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { useAdmin } from "./context.js";
import { ChangeValues } from "./AdminData.js";
import { ModelDeletionDialog, type ModelDeletionTarget } from "./ModelDeletionDialog.js";
import { explain } from "../../state/workspace.js";
import { ApiError } from "../../../../../src/clients/service-client.js";
import { Select } from "../../shared/select.js";
import { Pill } from "../../shared/ui.js";
import {
  AdminPage,
  Card,
  EmptyState,
  ErrorNote,
  ModelState,
  SectionTitle,
  priceText,
} from "./ui.js";
import type { ProviderPreset } from "../../../../../src/shared/provider-presets.js";
import type {
  AdminCostRow,
  AdminDeploymentDetail,
  AdminDeploymentSummary,
  AdminLlmOverview,
  AdminUser,
  AdminVersion,
  Provider,
} from "./types.js";

const formats: Record<string, string> = {
  anthropic: "Anthropic 原生",
  anthropic_compatible: "Anthropic 兼容入口",
  openai_chat: "OpenAI Chat Completions",
  openai_responses: "OpenAI Responses",
};
const priceKeys = ["input", "output", "cacheRead", "cacheWrite"] as const;
const priceLabels: Record<(typeof priceKeys)[number], string> = {
  input: "输入",
  output: "输出",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
};
const blankPrice = { input: "", output: "", cacheRead: "", cacheWrite: "" };
const priceInput = (
  price: { input: number; output: number; cacheRead: number; cacheWrite: number } | null | undefined,
) =>
  price
    ? Object.fromEntries(priceKeys.map((key) => [key, String(price[key] / 1000000)])) as typeof blankPrice
    : blankPrice;

export function AdminModels() {
  const { api, problem, notify } = useAdmin();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const filter = params.get("filter") ?? "all";
  const providerFilter = params.get("provider") ?? "";
  const selectedId = params.get("deployment") ?? "";
  const [providers, setProviders] = useState<Provider[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [deployments, setDeployments] = useState<AdminDeploymentSummary[]>([]);
  const [costPolicyRequired, setCostPolicyRequired] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>();
  const [detail, setDetail] = useState<AdminDeploymentDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);
  const [providerModal, setProviderModal] = useState<
    { mode: "create" } | { mode: "edit"; provider: Provider }
  >();
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<Provider>();
  const [archiveTarget, setArchiveTarget] = useState<AdminDeploymentSummary>();
  const [deleteTarget, setDeleteTarget] = useState<ModelDeletionTarget>();
  const deletedDeployment = useRef<string>();

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all([
      api.request<AdminLlmOverview>("/admin/llm", "GET", undefined, abort.signal),
      api.request<{ presets: ProviderPreset[] }>("/admin/llm/presets", "GET", undefined, abort.signal),
    ])
      .then(([value, presetData]) => {
        if (abort.signal.aborted) return;
        setProviders(value.providers);
        setDeployments(value.deployments);
        setCostPolicyRequired(value.costPolicyRequired);
        setPresets(presetData.presets);
      })
      .catch((value) => {
        if (abort.signal.aborted) return;
        setError(
          value instanceof ApiError && value.code === "LLM_DISABLED"
            ? "模型网关未接入，当前无法管理模型。"
            : explain(value),
        );
        problem(value);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, problem, version]);

  useEffect(() => {
    const abort = new AbortController();
    void api
      .request<AdminUser[]>("/admin/users", "GET", undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setUsers(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setUsers(undefined);
      });
    return () => abort.abort();
  }, [api]);

  useEffect(() => {
    if (!selectedId || selectedId === deletedDeployment.current) {
      setDetail(undefined);
      return;
    }
    const abort = new AbortController();
    void api
      .request<AdminDeploymentDetail>(
        `/admin/llm/deployments/${selectedId}`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setDetail(value);
      })
      .catch((value) => {
        if (abort.signal.aborted || selectedId === deletedDeployment.current) return;
        setDetail(undefined);
        problem(value);
      });
    return () => abort.abort();
  }, [api, selectedId, problem, version]);

  const providerMap = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const counts = {
    all: deployments.length,
    enabled: deployments.filter((item) => item.enabled && !item.archivedAt).length,
    disabled: deployments.filter((item) => !item.enabled && !item.archivedAt).length,
    unpriced: deployments.filter((item) => item.enabled && !item.price).length,
    issue: deployments.filter((item) =>
      !item.archivedAt &&
      (item.state !== "ready" || (costPolicyRequired && item.costMissing))
    ).length,
  };
  const visible = deployments.filter((item) => {
    if (providerFilter && item.currentVersion?.providerId !== providerFilter) return false;
    if (filter === "enabled" && (!item.enabled || item.archivedAt)) return false;
    if (filter === "disabled" && (item.enabled || item.archivedAt)) return false;
    if (filter === "unpriced" && !(item.enabled && !item.price)) return false;
    if (
      filter === "issue" &&
      (item.archivedAt || (item.state === "ready" && !(costPolicyRequired && item.costMissing)))
    )
      return false;
    const text = `${item.name} ${item.currentVersion?.upstreamModel ?? ""} ${item.providerName ?? ""}`.toLowerCase();
    return !query || text.includes(query.toLowerCase());
  });
  const selected = deployments.find((item) => item.id === selectedId);

  const action = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
      notify(message);
      refresh((value) => value + 1);
    } catch (value) {
      problem(value);
    }
  };

  return (
    <AdminPage
      title="模型与网关"
      subtitle="每个模型是一个命名部署；上游与能力由版本定义，切指针后已有会话下一轮生效。"
      error={error || undefined}
      onRetry={() => refresh((value) => value + 1)}
      actions={
        <HStack spacing={2} flexWrap="wrap">
          <Button as={Link} to="/models/setup" size="sm" variant="outline">快速接入</Button>
          <Button
            size="sm"
            variant="outline"
            leftIcon={<Plus size={14} />}
            onClick={() => setProviderModal({ mode: "create" })}
          >
            新增供应商
          </Button>
          <Button
            size="sm"
            leftIcon={<Plus size={14} />}
            onClick={() => {
              if (!providers.length) setProviderModal({ mode: "create" });
              else setDeploymentOpen(true);
            }}
          >
            新增模型
          </Button>
          <IconButton
            aria-label="刷新"
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={14} />}
            onClick={() => refresh((value) => value + 1)}
          />
        </HStack>
      }
    >
      <SimpleGrid columns={{ base: 1, md: 2, xl: 3 }} spacing={2.5} mb={4}>
        {providers.map((provider) => {
          const count = deployments.filter(
            (item) => item.currentVersion?.providerId === provider.id,
          ).length;
          return (
            <Card key={provider.id} p={3.5}>
              <Flex align="flex-start" gap={2}>
                <Box flex={1} minW={0}>
                  <Text fontSize="12.5px" fontWeight={600} noOfLines={1}>
                    {provider.name}
                  </Text>
                  <Text fontSize="10.5px" color="muted" fontFamily="mono" noOfLines={1}>
                    {provider.apiBase}
                  </Text>
                  <Text mt={1} fontSize="10.5px" color="muted">
                    {formats[provider.format] ?? provider.format} · {count} 个部署 ·
                    密钥 v{provider.secretVersion ?? "—"}
                  </Text>
                </Box>
                <IconButton
                  aria-label={`编辑 ${provider.name}`}
                  size="xs"
                  variant="ghost"
                  icon={<Pencil size={12} />}
                  onClick={() => setProviderModal({ mode: "edit", provider })}
                />
                <IconButton
                  aria-label={`轮换 ${provider.name} 密钥`}
                  size="xs"
                  variant="ghost"
                  icon={<KeyRound size={13} />}
                  onClick={() => setRotateTarget(provider)}
                />
                <IconButton
                  aria-label={`删除 ${provider.name}`}
                  size="xs"
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  onClick={() => setDeleteTarget({ kind: "provider", id: provider.id, name: provider.name })}
                />
              </Flex>
            </Card>
          );
        })}
      </SimpleGrid>

      <Flex gap={1.5} flexWrap="wrap" mb={3} align="center">
        {[
          ["all", "全部", counts.all],
          ["enabled", "启用", counts.enabled],
          ["disabled", "停用", counts.disabled],
          ["unpriced", "未定价", counts.unpriced],
          ["issue", "同步异常", counts.issue],
        ].map(([value, label, count]) => (
          <Button
            key={value as string}
            size="xs"
            variant={filter === value ? "tint" : "ghost"}
            onClick={() => update({ filter: value as string })}
          >
            {label} {count}
          </Button>
        ))}
        <Flex
          align="center"
          gap={1}
          px={2}
          h="28px"
          border="1px solid"
          borderColor="line"
          borderRadius="8px"
          bg="surface"
          ml="auto"
          maxW="220px"
        >
          <Search size={13} />
          <Input
            aria-label="搜索部署"
            size="xs"
            variant="unstyled"
            placeholder="名称 / 上游 / 供应商"
            value={query}
            onChange={(event) => update({ q: event.target.value })}
          />
          {query && (
            <IconButton
              aria-label="清除搜索"
              size="xs"
              variant="ghost"
              minW="16px"
              h="16px"
              icon={<X size={11} />}
              onClick={() => update({ q: "" })}
            />
          )}
        </Flex>
      </Flex>

      {selectedId && (
        <Flex fontSize="11px" color="muted" mb={2} align="center" gap={2}>
          <Text>
            供应商筛选：
            {providerFilter ? providerMap.get(providerFilter)?.name ?? providerFilter : "全部"}
          </Text>
          {providerFilter && (
            <Button size="xs" variant="ghost" onClick={() => update({ provider: "" })}>
              清除
            </Button>
          )}
        </Flex>
      )}

      {loading ? (
        <Flex justify="center" py={12}>
          <Spinner size="sm" />
        </Flex>
      ) : visible.length ? (
        <SimpleGrid columns={{ base: 1, lg: 2 }} spacing={2.5}>
          {visible.map((deployment) => (
            <Card
              key={deployment.id}
              as="button"
              textAlign="left"
              p={4}
              cursor="pointer"
              onClick={() => update({ deployment: deployment.id })}
              _hover={{ borderColor: "lineStrong" }}
            >
              <Flex align="flex-start" gap={2}>
                <Box flex={1} minW={0}>
                  <HStack spacing={2}>
                    <Text fontSize="13px" fontWeight={600} noOfLines={1}>
                      {deployment.name}
                    </Text>
                    {deployment.archivedAt && <Pill tone="neutral">已归档</Pill>}
                    {deployment.deletionState && <Pill tone="amber">删除待确认</Pill>}
                  </HStack>
                  <Text fontSize="10.5px" color="muted" mt={0.5}>
                    {deployment.providerName ?? "未知供应商"} ·{" "}
                    {deployment.currentVersion?.upstreamModel ?? "未配置"}
                  </Text>
                </Box>
                <ModelState state={deployment.state} />
              </Flex>
              <HStack mt={2.5} spacing={2} flexWrap="wrap">
                <Pill tone={deployment.enabled ? "teal" : "neutral"}>
                  {deployment.enabled ? "启用" : "停用"}
                </Pill>
                {deployment.setupPending && <Pill tone="amber">接入测试待完成</Pill>}
                {!deployment.price && <Pill tone="amber">未定价</Pill>}
                {costPolicyRequired && deployment.costMissing && <Pill tone="amber">未配成本</Pill>}
                <Text fontSize="10.5px" color="muted">
                  v{deployment.versionCount} · {deployment.liveSessions} 个活跃会话
                </Text>
              </HStack>
              <Text mt={2} fontSize="11px" color={deployment.price ? "ink2" : "warnStrong"}>
                {deployment.price ? priceText(deployment.price) : "尚未设置平台价格"}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      ) : (
        <EmptyState
          title="没有匹配的部署"
          description={
            deployments.length
              ? "调整筛选或搜索条件。"
              : "先新增供应商，再创建命名部署。"
          }
        />
      )}

      <ProviderModal
        api={api}
        open={!!providerModal}
        presets={presets}
        provider={providerModal?.mode === "edit" ? providerModal.provider : undefined}
        notify={notify}
        problem={problem}
        onClose={() => setProviderModal(undefined)}
        onSaved={() => refresh((value) => value + 1)}
      />
      <DeploymentModal
        api={api}
        open={deploymentOpen}
        providers={providers}
        costRequired={costPolicyRequired}
        defaultProvider={providerFilter || providers[0]?.id || ""}
        notify={notify}
        problem={problem}
        onClose={() => setDeploymentOpen(false)}
        onCreateProvider={() => {
          setDeploymentOpen(false);
          setProviderModal({ mode: "create" });
        }}
        onSaved={() => refresh((value) => value + 1)}
      />
      <RotateModal
        api={api}
        provider={rotateTarget}
        notify={notify}
        problem={problem}
        onClose={() => setRotateTarget(undefined)}
        onSaved={() => refresh((value) => value + 1)}
      />
      <Modal isOpen={!!archiveTarget} onClose={() => setArchiveTarget(undefined)}>
        <ModalOverlay />
        <ModalContent mx={4}>
          <ModalHeader>归档部署？</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text fontSize="12.5px">
              「{archiveTarget?.name}」归档后不再出现在模型列表；只有没有活跃会话时才能归档。
            </Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={2} onClick={() => setArchiveTarget(undefined)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = archiveTarget;
                setArchiveTarget(undefined);
                if (target)
                  void action(
                    () => api.request(`/admin/llm/deployments/${target.id}/archive`, "POST"),
                    "部署已归档",
                  );
              }}
            >
              确认归档
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Drawer
        isOpen={!!selectedId}
        onClose={() => update({ deployment: "" })}
        size={{ base: "full", md: "md" }}
        placement="right"
      >
        <DrawerOverlay />
        <DrawerContent>
          <DrawerCloseButton />
          <DrawerHeader fontSize="15px">部署详情</DrawerHeader>
          <DrawerBody pb={8}>
            {selected && detail ? (
              <DeploymentDetail
                api={api}
                summary={selected}
                detail={detail}
                providers={providers}
                users={users}
                notify={notify}
                problem={problem}
                onChanged={() => refresh((value) => value + 1)}
                onArchive={() => setArchiveTarget(selected)}
                onDelete={() => setDeleteTarget({ kind: "deployment", id: selected.id, name: selected.name })}
              />
            ) : (
              <Flex justify="center" py={10}>
                <Spinner size="sm" />
              </Flex>
            )}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
      {deleteTarget && (
        <ModelDeletionDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(undefined)}
          onChanged={() => refresh(value => value + 1)}
          onDeleted={() => {
            if (deleteTarget.kind === "deployment") {
              deletedDeployment.current = deleteTarget.id;
              update({ deployment: "" });
            } else if (providerFilter === deleteTarget.id) update({ provider: "" });
            notify(deleteTarget.kind === "provider" ? "供应商已删除" : "模型已删除");
            setDeleteTarget(undefined);
            refresh(value => value + 1);
          }}
        />
      )}
    </AdminPage>
  );
}

function DeploymentDetail({
  api,
  summary,
  detail,
  providers,
  users,
  notify,
  problem,
  onChanged,
  onArchive,
  onDelete,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  summary: AdminDeploymentSummary;
  detail: AdminDeploymentDetail;
  providers: Provider[];
  users?: AdminUser[];
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onChanged: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [tab, setTab] = useState<"basic" | "versions" | "cost" | "price" | "users" | "audit">("basic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const deployment = detail.deployment;
  useEffect(() => {
    setTab("basic");
    setError("");
  }, [deployment.id]);
  const run = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    try {
      await work();
      notify(message);
      onChanged();
    } catch (value) {
      setError(explain(value));
      problem(value);
    } finally {
      setBusy(false);
    }
  };
  if (deployment.deletionState) return (
    <Stack spacing={3}>
      <ErrorNote message="模型已停止提供，网关清理尚待确认。" />
      <Button size="sm" alignSelf="start" variant="danger" onClick={onDelete}>继续删除</Button>
    </Stack>
  );
  return (
    <Stack spacing={4}>
      <Card p={4}>
        <Text fontSize="15px" fontWeight={650}>
          {deployment.name}
        </Text>
        <Text mt={1} fontSize="11px" color="muted">
          {summary.providerName ?? "未知供应商"} · 当前版本{" "}
          <Text as="span" fontFamily="mono">
            {summary.currentVersion?.routeName ?? "—"}
          </Text>
        </Text>
        <HStack mt={2} spacing={2} flexWrap="wrap">
          <ModelState state={summary.state} />
          <Pill tone={deployment.enabled ? "teal" : "neutral"}>
            {deployment.enabled ? "启用" : "停用"}
          </Pill>
          {deployment.archivedAt && <Pill tone="neutral">已归档</Pill>}
          {!summary.price && <Pill tone="amber">未定价</Pill>}
          <Text fontSize="10.5px" color="muted">
            {summary.versionCount} 个版本 · {summary.liveSessions} 个活跃会话
          </Text>
        </HStack>
      </Card>

      <Flex gap={1} flexWrap="wrap">
        {[
          ["basic", "概览"],
          ["versions", "版本"],
          ["cost", "成本"],
          ["price", "价格"],
          ["users", "使用范围"],
          ["audit", "审计"],
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
      {error && <ErrorNote message={error} />}

      {tab === "basic" && (
        <Card p={4}>
          <Stack spacing={2.5} fontSize="12.5px">
            <Flex gap={3}>
              <Text color="muted" w="76px" flexShrink={0}>
                说明
              </Text>
              <Text color="ink2">{deployment.description || "—"}</Text>
            </Flex>
            <Flex gap={3}>
              <Text color="muted" w="76px" flexShrink={0}>
                上游标识
              </Text>
              <Text fontFamily="mono">{summary.currentVersion?.upstreamModel ?? "—"}</Text>
            </Flex>
            <Flex gap={3}>
              <Text color="muted" w="76px" flexShrink={0}>
                能力声明
              </Text>
              <Text>
                {summary.currentVersion?.tools ? "工具调用" : "无工具调用"} ·{" "}
                {summary.currentVersion?.streaming ? "流式输出" : "非流式"}
              </Text>
            </Flex>
          </Stack>
          <HStack mt={4} spacing={2} flexWrap="wrap">
            <Button
              size="sm"
              variant="outline"
              isLoading={busy}
              isDisabled={!!deployment.archivedAt}
              onClick={() =>
                void run(
                  () =>
                    api.request(`/admin/llm/deployments/${deployment.id}`, "PATCH", {
                      enabled: !deployment.enabled,
                    }),
                  deployment.enabled ? "部署已停用" : "部署已启用",
                )
              }
            >
              {deployment.enabled ? "停用部署" : "启用部署"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              isLoading={busy}
              isDisabled={!!deployment.archivedAt}
              onClick={() =>
                void run(
                  () => api.request(`/admin/llm/deployments/${deployment.id}/sync`, "POST"),
                  "同步状态已重新核对",
                )
              }
            >
              重新核对同步
            </Button>
            {!deployment.archivedAt && (
              <Button size="sm" variant="danger" leftIcon={<Archive size={13} />} onClick={onArchive}>
                归档
              </Button>
            )}
            <Button size="sm" variant="danger" leftIcon={<Trash2 size={13} />} onClick={onDelete}>
              删除模型
            </Button>
          </HStack>
          <Text mt={3} fontSize="10.5px" color="muted" lineHeight={1.6}>
            版本内容不可变；切换当前版本后，已有会话在下一轮自动使用新版本，并记录 model.replaced 事件。
          </Text>
        </Card>
      )}

      {tab === "versions" && (
        <VersionsTab
          api={api}
          summary={summary}
          versions={detail.versions}
          providers={providers}
          notify={notify}
          problem={problem}
          onChanged={onChanged}
        />
      )}
      {tab === "cost" && (
        <CostTab
          api={api}
          summary={summary}
          versions={detail.versions}
          notify={notify}
          problem={problem}
          onChanged={onChanged}
        />
      )}
      {tab === "price" && (
        <PriceTab
          api={api}
          summary={summary}
          prices={detail.prices}
          notify={notify}
          problem={problem}
          onChanged={onChanged}
        />
      )}
      {tab === "users" && (
        <UsersTab
          api={api}
          deploymentId={deployment.id}
          allowedUsers={deployment.allowedUsers}
          users={users}
          notify={notify}
          problem={problem}
          onChanged={onChanged}
        />
      )}
      {tab === "audit" && (
        <Card p={4}>
          <SectionTitle title="变更记录" detail="只追加；包含操作人、动作和前后值。" />
          {detail.audit.length ? (
            <Stack spacing={2} mt={2}>
              {detail.audit.map((entry) => (
                <Box key={entry.id} borderBottom="1px solid" borderColor="line" pb={2}>
                  <Text fontSize="11.5px" fontWeight={550}>
                    {entry.action} · {entry.actor}
                  </Text>
                  <Text fontSize="10.5px" color="muted">
                    {new Date(entry.createdAt).toLocaleString()}
                  </Text>
                  <Box as="details" mt={2}><Box as="summary" cursor="pointer" fontSize="12px">查看变更前后值</Box><ChangeValues before={entry.before} after={entry.after}/></Box>
                </Box>
              ))}
            </Stack>
          ) : (
            <Text mt={2} fontSize="11.5px" color="muted">
              暂无记录。
            </Text>
          )}
        </Card>
      )}
    </Stack>
  );
}

function VersionsTab({
  api,
  summary,
  versions,
  providers,
  notify,
  problem,
  onChanged,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  summary: AdminDeploymentSummary;
  versions: AdminVersion[];
  providers: Provider[];
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onChanged: () => void;
}) {
  const { requestChange } = useAdmin();
  const [providerId, setProviderId] = useState(summary.currentVersion?.providerId ?? providers[0]?.id ?? "");
  const [upstream, setUpstream] = useState(summary.currentVersion?.upstreamModel ?? "");
  const [tools, setTools] = useState(summary.currentVersion?.tools ?? true);
  const [streaming, setStreaming] = useState(summary.currentVersion?.streaming ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const point = async (versionId: string) => {
    setBusy(true);
    setError("");
    try {
      await requestChange(`/admin/llm/deployments/${summary.id}/current`, "POST", {
        versionId,
        expectedVersionId: summary.currentVersionId,
      });
      notify("当前版本已切换");
      onChanged();
    } catch (value) {
      setError(explain(value));
      problem(value);
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      await api.request(`/admin/llm/deployments/${summary.id}/versions`, "POST", {
        providerId,
        upstreamModel: upstream,
        tools,
        streaming,
      });
      notify("新版本已发布；当前指针未改变");
      onChanged();
    } catch (value) {
      setError(explain(value));
      problem(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={3}>
      {error && <ErrorNote message={error} />}
      <Card p={4}>
        <SectionTitle title="版本历史" detail="版本内容不可变；设为当前只改变指针。" />
        <Stack spacing={2} mt={2}>
          {versions.map((version) => {
            const current = version.id === summary.currentVersionId;
            return (
              <Box key={version.id} border="1px solid" borderColor={current ? "brand.300" : "line"} borderRadius="9px" p={2.5}>
                <Flex align="center" gap={2}>
                  <Box flex={1} minW={0}>
                    <Text fontSize="11.5px" fontFamily="mono" noOfLines={1}>
                      {version.routeName}
                    </Text>
                    <Text fontSize="10.5px" color="muted">
                      {providers.find((item) => item.id === version.providerId)?.name ?? "未知供应商"} ·{" "}
                      {version.upstreamModel} · {new Date(version.createdAt).toLocaleString()}
                    </Text>
                  </Box>
                  <ModelState state={version.state} />
                  {current ? (
                    <Pill tone="teal">当前</Pill>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      leftIcon={<RotateCcw size={11} />}
                      isLoading={busy}
                      onClick={() => void point(version.id)}
                    >
                      设为当前
                    </Button>
                  )}
                </Flex>
              </Box>
            );
          })}
        </Stack>
      </Card>
      <Card p={4}>
        <SectionTitle title="发布新版本" detail="不会自动切换当前指针；需要显式设为当前。" />
        <Stack spacing={2.5} mt={2}>
          <FormControl>
            <FormLabel fontSize="12px">供应商</FormLabel>
            <Select
              ariaLabel="新版本供应商"
              value={providerId}
              onChange={setProviderId}
              options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
            />
          </FormControl>
          <FormControl>
            <FormLabel fontSize="12px">上游标识</FormLabel>
            <Input
              aria-label="新版本上游标识"
              value={upstream}
              onChange={(event) => setUpstream(event.target.value)}
            />
          </FormControl>
          <HStack spacing={4}>
            <Checkbox isChecked={tools} onChange={(event) => setTools(event.target.checked)}>
              工具调用
            </Checkbox>
            <Checkbox isChecked={streaming} onChange={(event) => setStreaming(event.target.checked)}>
              流式输出
            </Checkbox>
          </HStack>
          <Button
            size="sm"
            alignSelf="flex-start"
            isLoading={busy}
            isDisabled={!providerId || !upstream.trim()}
            onClick={() => void publish()}
          >
            发布新版本
          </Button>
        </Stack>
      </Card>
    </Stack>
  );
}

function CostTab({
  api,
  summary,
  versions,
  notify,
  problem,
  onChanged,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  summary: AdminDeploymentSummary;
  versions: AdminDeploymentDetail["versions"];
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onChanged: () => void;
}) {
  const { requestChange } = useAdmin();
  const current = versions.find((version) => version.id === summary.currentVersionId) ?? versions[0];
  const [history, setHistory] = useState<AdminCostRow[]>([]);
  const [form, setForm] = useState({
    inputUsdPerMillion: "",
    outputUsdPerMillion: "",
    cacheReadUsdPerMillion: "",
    cacheWriteUsdPerMillion: "",
    timeoutSeconds: "180",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!current) {
      setHistory([]);
      return;
    }
    const abort = new AbortController();
    void api
      .request<{ costs: AdminCostRow[] }>(
        `/admin/llm/versions/${current.id}/costs`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setHistory(value.costs);
      })
      .catch((value) => {
        if (!abort.signal.aborted) problem(value);
      });
    return () => abort.abort();
  }, [api, current?.id, problem, summary.currentVersionId]);
  useEffect(() => {
    const cost = current?.cost;
    setForm(
      cost
        ? {
            inputUsdPerMillion: String(cost.inputCostPerToken * 1e6),
            outputUsdPerMillion: String(cost.outputCostPerToken * 1e6),
            cacheReadUsdPerMillion: String(cost.cacheReadCostPerToken * 1e6),
            cacheWriteUsdPerMillion: String(cost.cacheWriteCostPerToken * 1e6),
            timeoutSeconds: String(cost.timeoutSeconds),
          }
        : {
            inputUsdPerMillion: "",
            outputUsdPerMillion: "",
            cacheReadUsdPerMillion: "",
            cacheWriteUsdPerMillion: "",
            timeoutSeconds: "180",
          },
    );
  }, [current?.id, current?.cost]);
  const save = async () => {
    if (!current) return;
    setBusy(true);
    setError("");
    try {
      await requestChange(`/admin/llm/versions/${current.id}/costs`, "POST", form);
      notify("供应商成本已发布");
      onChanged();
    } catch (value) {
      setError(explain(value));
      problem(value);
    } finally {
      setBusy(false);
    }
  };
  if (!current)
    return (
      <Card p={4}>
        <Text fontSize="12px" color="muted">
          没有可用版本。
        </Text>
      </Card>
    );
  return (
    <Stack spacing={3}>
      {error && <ErrorNote message={error} />}
      <Card p={4}>
        <SectionTitle
          title="供应商成本"
          detail="美元/百万 Token。成本按供应商 + 上游模型共享，影响所有引用该上游模型的版本。"
        />
        <Text mt={2} fontSize="11px" color="muted">
          来源：{current.cost ? (current.cost.source === "database" ? "后台配置" : "策略文件回退") : "未配置"}
          {" · "}当前版本 {current.routeName}
        </Text>
        <SimpleGrid columns={{ base: 1, sm: 2 }} gap={3} mt={3}>
          {(
            [
              ["inputUsdPerMillion", "输入"],
              ["outputUsdPerMillion", "输出"],
              ["cacheReadUsdPerMillion", "缓存读取"],
              ["cacheWriteUsdPerMillion", "缓存写入"],
            ] as const
          ).map(([key, label]) => (
            <FormControl key={key}>
              <FormLabel fontSize="12px">{label}（美元/百万）</FormLabel>
              <Input
                aria-label={`供应商${label}成本`}
                type="number"
                min={0}
                step="0.000001"
                value={form[key]}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              />
            </FormControl>
          ))}
          <FormControl>
            <FormLabel fontSize="12px">请求超时（秒）</FormLabel>
            <Input
              aria-label="供应商请求超时"
              type="number"
              min={1}
              max={3600}
              value={form.timeoutSeconds}
              onChange={(event) => setForm({ ...form, timeoutSeconds: event.target.value })}
            />
          </FormControl>
        </SimpleGrid>
        <Button
          mt={3}
          size="sm"
          isLoading={busy}
          isDisabled={[
            "inputUsdPerMillion",
            "outputUsdPerMillion",
            "cacheReadUsdPerMillion",
            "cacheWriteUsdPerMillion",
            "timeoutSeconds",
          ].some((key) => form[key as keyof typeof form] === "")}
          onClick={() => void save()}
        >
          发布新成本
        </Button>
      </Card>
      <Card p={4}>
        <SectionTitle title="成本历史" detail="只追加；请求按发生时生效的成本计价。" />
        <Table size="sm" mt={2}>
          <Thead>
            <Tr>
              <Th>生效时间</Th>
              <Th>输入/输出</Th>
              <Th>缓存读写</Th>
              <Th>超时</Th>
            </Tr>
          </Thead>
          <Tbody>
            {history.map((row) => (
              <Tr key={row.id}>
                <Td fontSize="10.5px">{new Date(row.effectiveFrom).toLocaleString()}</Td>
                <Td fontSize="10.5px">
                  {(row.inputUsdPerToken * 1e6).toFixed(6)} / {(row.outputUsdPerToken * 1e6).toFixed(6)}
                </Td>
                <Td fontSize="10.5px">
                  {(row.cacheReadUsdPerToken * 1e6).toFixed(6)} / {(row.cacheWriteUsdPerToken * 1e6).toFixed(6)}
                </Td>
                <Td fontSize="10.5px">{row.timeoutSeconds}s</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
        {!history.length && (
          <Text mt={2} fontSize="11.5px" color="muted">
            尚无后台成本记录；可能正在使用策略文件回退。
          </Text>
        )}
      </Card>
    </Stack>
  );
}

function PriceTab({
  api,
  summary,
  prices,
  notify,
  problem,
  onChanged,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  summary: AdminDeploymentSummary;
  prices: AdminDeploymentDetail["prices"];
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onChanged: () => void;
}) {
  const { requestChange } = useAdmin();
  const [price, setPrice] = useState(priceInput(summary.price));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setPrice(priceInput(summary.price)), [summary.price]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await requestChange(`/admin/llm/deployments/${summary.id}/prices`, "POST", price);
      notify("新价格已发布");
      onChanged();
    } catch (value) {
      setError(explain(value));
      problem(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card p={4}>
      <SectionTitle title="平台价格" detail="单位：元/百万 Token；每次保存生成新价格版本，历史请求不回溯。" />
      {error && <ErrorNote message={error} />}
      <SimpleGrid columns={{ base: 1, sm: 2 }} gap={3} mt={3}>
        {priceKeys.map((key) => (
          <FormControl key={key}>
            <FormLabel fontSize="12px">{priceLabels[key]}</FormLabel>
            <Input
              aria-label={`${priceLabels[key]}单价`}
              type="number"
              min={0}
              step="0.000001"
              value={price[key]}
              onChange={(event) => setPrice({ ...price, [key]: event.target.value })}
            />
          </FormControl>
        ))}
      </SimpleGrid>
      {!summary.price && (
        <Text mt={2} fontSize="11.5px" color="warnStrong">
          当前未定价；钱包启用时该部署不能执行。
        </Text>
      )}
      <Button
        mt={3}
        size="sm"
        isLoading={busy}
        isDisabled={priceKeys.some((key) => price[key] === "")}
        onClick={() => void save()}
      >
        发布新价格
      </Button>
      <Box mt={4}>
        <Text fontSize="10.5px" fontWeight={600} color="muted" mb={1}>
          价格历史
        </Text>
        <Table size="sm">
          <Thead>
            <Tr>
              <Th>生效时间</Th>
              <Th>输入/输出</Th>
              <Th>缓存读写</Th>
            </Tr>
          </Thead>
          <Tbody>
            {prices.map((row) => (
              <Tr key={row.id}>
                <Td fontSize="10.5px">{new Date(row.effectiveFrom).toLocaleString()}</Td>
                <Td fontSize="10.5px">
                  {row.input / 1000000} / {row.output / 1000000}
                </Td>
                <Td fontSize="10.5px">
                  {row.cacheRead / 1000000} / {row.cacheWrite / 1000000}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>
    </Card>
  );
}

function UsersTab({
  api,
  deploymentId,
  allowedUsers,
  users,
  notify,
  problem,
  onChanged,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  deploymentId: string;
  allowedUsers: string[];
  users?: AdminUser[];
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onChanged: () => void;
}) {
  const { requestChange } = useAdmin();
  const [allowed, setAllowed] = useState<string[]>(allowedUsers);
  const [userQuery, setUserQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setAllowed(allowedUsers), [allowedUsers]);
  const available = (users ?? []).filter(
    (user) =>
      !allowed.includes(user.id) &&
      (!userQuery || `${user.name} ${user.id}`.toLowerCase().includes(userQuery.toLowerCase())),
  );
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await requestChange(`/admin/llm/deployments/${deploymentId}`, "PATCH", { allowedUsers: allowed });
      notify("使用范围已保存");
      onChanged();
    } catch (value) {
      setError(explain(value));
      problem(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card p={4}>
      <SectionTitle title="使用范围" detail="留空表示所有用户；缩小范围会撤销不再允许的会话 Key。" />
      {error && <ErrorNote message={error} />}
      <Flex gap={1.5} flexWrap="wrap" mt={3} mb={3}>
        {allowed.length ? (
          allowed.map((id) => {
            const user = users?.find((item) => item.id === id);
            return (
              <Pill key={id} tone="blue">
                <Flex align="center" gap={1}>
                  {user?.name ?? id}
                  <IconButton
                    aria-label={`移除 ${user?.name ?? id}`}
                    variant="ghost"
                    size="xs"
                    minW="16px"
                    h="16px"
                    icon={<X size={11} />}
                    onClick={() => setAllowed(allowed.filter((item) => item !== id))}
                  />
                </Flex>
              </Pill>
            );
          })
        ) : (
          <Text fontSize="12px" color="muted">
            所有用户可用
          </Text>
        )}
      </Flex>
      {users ? (
        <>
          <Input
            aria-label="搜索可添加的用户"
            placeholder="搜索用户名称或 ID"
            size="sm"
            value={userQuery}
            onChange={(event) => setUserQuery(event.target.value)}
          />
          <Box mt={2} maxH="200px" overflowY="auto" border="1px solid" borderColor="line" borderRadius="9px">
            {available.length ? (
              available.slice(0, 50).map((user) => (
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
                  _hover={{ bg: "surfaceHover" }}
                  onClick={() => {
                    if (!allowed.includes(user.id)) setAllowed([...allowed, user.id]);
                    setUserQuery("");
                  }}
                >
                  <Text fontSize="12px" fontWeight={550}>
                    {user.name}
                  </Text>
                  <Text fontSize="10.5px" color="muted" fontFamily="mono">
                    {user.id}
                  </Text>
                </Box>
              ))
            ) : (
              <Text px={3} py={4} fontSize="12px" color="muted">
                {userQuery ? "没有匹配的用户" : "没有可添加的用户"}
              </Text>
            )}
          </Box>
        </>
      ) : (
        <Text fontSize="11.5px" color="muted">
          用户列表读取失败或尚未加载；可以先保存为空（所有用户）或稍后重试。
        </Text>
      )}
      <Button mt={3} size="sm" isLoading={busy} onClick={() => void save()}>
        保存使用范围
      </Button>
    </Card>
  );
}

function ProviderModal({
  api,
  open,
  provider,
  presets,
  notify,
  problem,
  onClose,
  onSaved,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  open: boolean;
  provider?: Provider;
  presets: ProviderPreset[];
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { requestChange } = useAdmin();
  const [presetId, setPresetId] = useState("__custom__");
  const [name, setName] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [format, setFormat] = useState("anthropic_compatible");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setPresetId("__custom__");
      setName(provider?.name ?? "");
      setApiBase(provider?.apiBase ?? "");
      setFormat(provider?.format ?? "anthropic_compatible");
      setApiKey("");
      setError("");
    }
  }, [open, provider]);
  const preset = presets.find((item) => item.id === presetId);
  const editing = !!provider;
  return (
    <Modal isOpen={open} onClose={onClose}>
      <ModalOverlay />
      <ModalContent
        mx={4}
        as="form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const request = editing
            ? requestChange(`/admin/llm/providers/${provider!.id}`, "PATCH", { name, apiBase })
            : api.request("/admin/llm/providers", "POST", { name, apiBase, apiKey, format });
          void request
            .then(() => {
              notify(editing ? "供应商已更新" : "供应商已保存");
              onClose();
              onSaved();
            })
            .catch((value) => {
              setError(explain(value));
              problem(value);
            })
            .finally(() => setBusy(false));
        }}
      >
        <ModalHeader>{editing ? "编辑供应商" : "新增供应商"}</ModalHeader>
        <ModalCloseButton isDisabled={busy} />
        <ModalBody>
          <Stack spacing={3}>
            {error && <ErrorNote message={error} />}
            {!editing && (
              <FormControl>
                <FormLabel>预置供应商</FormLabel>
                <Select
                  ariaLabel="预置供应商"
                  value={presetId}
                  onChange={(value) => {
                    setPresetId(value);
                    const item = presets.find((candidate) => candidate.id === value);
                    if (!item) return;
                    setName(item.name);
                    setApiBase(item.apiBase);
                    setFormat(item.format);
                  }}
                  options={[
                    { value: "__custom__", label: "自定义供应商" },
                    ...presets.map((item) => ({
                      value: item.id,
                      label: `${item.group} · ${item.name}`,
                    })),
                  ]}
                />
                {preset && (
                  <Text mt={1.5} fontSize="10.5px" color="muted">
                    {preset.keyHint ?? "模型示例可在新增模型时读取或手动填写。"}
                    {preset.docsUrl ? ` 文档：${preset.docsUrl}` : ""}
                  </Text>
                )}
              </FormControl>
            )}
            <FormControl isRequired>
              <FormLabel>供应商名称</FormLabel>
              <Input aria-label="供应商名称" required value={name} onChange={(event) => setName(event.target.value)} />
            </FormControl>
            <FormControl isRequired>
              <FormLabel>API 地址</FormLabel>
              <Input
                aria-label="供应商 API 地址"
                required
                placeholder="https://…（接口根地址）"
                value={apiBase}
                onChange={(event) => setApiBase(event.target.value)}
              />
            </FormControl>
            {editing ? (
              <Text fontSize="11px" color="muted">
                当前协议：{formats[provider!.format] ?? provider!.format}。协议属于版本身份，变更请新增供应商并发布新版本；密钥请使用轮换。
              </Text>
            ) : (
              <FormControl>
                <FormLabel>上游协议</FormLabel>
                <Select
                  ariaLabel="上游协议"
                  value={format}
                  onChange={setFormat}
                  options={Object.entries(formats).map(([value, label]) => ({ value, label }))}
                />
              </FormControl>
            )}
            {!editing && (
              <FormControl isRequired>
                <FormLabel>API Key</FormLabel>
                <Input
                  aria-label="供应商 API Key"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder="保存后不回显"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </FormControl>
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" mr={2} isDisabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" isLoading={busy}>
            {editing ? "保存修改" : "保存供应商"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function DeploymentModal({
  api,
  open,
  providers,
  costRequired,
  defaultProvider,
  notify,
  problem,
  onClose,
  onCreateProvider,
  onSaved,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  open: boolean;
  providers: Provider[];
  costRequired: boolean;
  defaultProvider: string;
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onClose: () => void;
  onCreateProvider: () => void;
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState(defaultProvider);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [upstream, setUpstream] = useState("");
  const [tools, setTools] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const [price, setPrice] = useState(blankPrice);
  const [cost, setCost] = useState({
    inputUsdPerMillion: "",
    outputUsdPerMillion: "",
    cacheReadUsdPerMillion: "",
    cacheWriteUsdPerMillion: "",
    timeoutSeconds: "180",
  });
  const [discovered, setDiscovered] = useState<Array<{ id: string; displayName?: string }>>([]);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setProviderId(defaultProvider || providers[0]?.id || "");
      setName("");
      setDescription("");
      setUpstream("");
      setTools(true);
      setStreaming(true);
      setPrice(blankPrice);
      setCost({
        inputUsdPerMillion: "",
        outputUsdPerMillion: "",
        cacheReadUsdPerMillion: "",
        cacheWriteUsdPerMillion: "",
        timeoutSeconds: "180",
      });
      setDiscovered([]);
      setDiscoverError("");
      setModelQuery("");
      setError("");
    }
  }, [open, defaultProvider, providers]);
  const priced = priceKeys.some((key) => price[key] !== "");
  const costKeys = [
    "inputUsdPerMillion",
    "outputUsdPerMillion",
    "cacheReadUsdPerMillion",
    "cacheWriteUsdPerMillion",
  ] as const;
  const costFilled = costKeys.every((key) => cost[key] !== "") && cost.timeoutSeconds !== "";
  const costStarted = costKeys.some((key) => cost[key] !== "");
  const discover = async () => {
    setDiscoverBusy(true);
    setDiscoverError("");
    try {
      const result = await api.request<{ models: Array<{ id: string; displayName?: string }> }>(
        `/admin/llm/providers/${providerId}/discover`,
        "POST",
      );
      setDiscovered(result.models);
      if (!result.models.length) setDiscoverError("供应商没有返回模型列表，可手动填写。");
    } catch (value) {
      setDiscovered([]);
      setDiscoverError(explain(value));
      problem(value);
    } finally {
      setDiscoverBusy(false);
    }
  };
  const filteredModels = discovered.filter(
    (model) =>
      !modelQuery ||
      `${model.id} ${model.displayName ?? ""}`.toLowerCase().includes(modelQuery.toLowerCase()),
  );
  return (
    <Modal isOpen={open} onClose={onClose} size="lg">
      <ModalOverlay />
      <ModalContent
        mx={4}
        as="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (priced && priceKeys.some((key) => price[key] === "")) {
            setError("价格需要四项都填写，或全部留空。");
            return;
          }
          if (costRequired && !costFilled) {
            setError("当前启用了成本策略，供应商成本四项和超时必须填写。");
            return;
          }
          if (costStarted && !costFilled) {
            setError("供应商成本需要四项和超时都填写，或全部留空。");
            return;
          }
          setBusy(true);
          setError("");
          void api
            .request<AdminDeploymentDetail>("/admin/llm/deployments", "POST", {
              providerId,
              name,
              description,
              upstreamModel: upstream,
              tools,
              streaming,
              allowedUsers: [],
              ...(priced ? { price } : {}),
              ...(costStarted ? { cost } : {}),
            })
            .then((detail) => {
              const current = detail.versions.find((item) => item.id === detail.deployment.currentVersionId);
              notify(current?.state === "ready" ? "模型已创建并同步" : "模型已保存，网关同步待核对");
              onClose();
              onSaved();
            })
            .catch((value) => {
              setError(explain(value));
              problem(value);
            })
            .finally(() => setBusy(false));
        }}
      >
        <ModalHeader>新增模型（部署）</ModalHeader>
        <ModalCloseButton isDisabled={busy} />
        <ModalBody>
          <Stack spacing={3}>
            {error && <ErrorNote message={error} />}
            <FormControl isRequired>
              <FormLabel>供应商（上游 API 账号）</FormLabel>
              <Flex gap={2}>
                <Select
                  ariaLabel="部署供应商"
                  value={providerId}
                  onChange={setProviderId}
                  options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
                />
                <Button size="sm" variant="outline" flexShrink={0} onClick={onCreateProvider}>
                  新增
                </Button>
              </Flex>
              <Text mt={1.5} fontSize="10.5px" color="muted">
                同一供应商可以承载多个模型。MIMO 与 DeepSeek 使用同一地址和密钥时，选择现有供应商；地址或密钥不同则先新增供应商。
              </Text>
            </FormControl>
            <FormControl isRequired>
              <FormLabel>部署名称（用户可见）</FormLabel>
              <Input aria-label="部署名称" required value={name} onChange={(event) => setName(event.target.value)} />
            </FormControl>
            <FormControl>
              <FormLabel>说明</FormLabel>
              <Input
                aria-label="部署说明"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </FormControl>
            <FormControl isRequired>
              <FormLabel>上游模型标识</FormLabel>
              <Flex gap={2}>
                <Input
                  aria-label="上游模型标识"
                  required
                  placeholder="例如 mimo-v2"
                  value={upstream}
                  onChange={(event) => setUpstream(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  flexShrink={0}
                  isLoading={discoverBusy}
                  onClick={() => void discover()}
                >
                  读取模型
                </Button>
              </Flex>
              {discoverError && (
                <Text mt={1.5} fontSize="10.5px" color="warnStrong">
                  {discoverError}
                </Text>
              )}
              {discovered.length > 0 && (
                <Box mt={2}>
                  <Text fontSize="10.5px" color="muted" mb={1}>
                    供应商返回 {discovered.length} 个模型；点击填入上游标识。
                  </Text>
                  <Input
                    aria-label="筛选供应商模型"
                    size="sm"
                    placeholder="搜索模型"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                  <Box
                    mt={1.5}
                    maxH="180px"
                    overflowY="auto"
                    border="1px solid"
                    borderColor="line"
                    borderRadius="9px"
                  >
                    {filteredModels.slice(0, 200).map((model) => (
                      <Box
                        as="button"
                        key={model.id}
                        w="100%"
                        textAlign="left"
                        px={3}
                        py={1.5}
                        borderTop="1px solid"
                        borderColor="line"
                        _first={{ borderTop: 0 }}
                        _hover={{ bg: "surfaceHover" }}
                        onClick={() => {
                          setUpstream(model.id);
                          if (!name.trim()) setName(model.id);
                        }}
                      >
                        <Text fontSize="11.5px" fontFamily="mono">
                          {model.id}
                        </Text>
                        {model.displayName && (
                          <Text fontSize="10px" color="muted">
                            {model.displayName}
                          </Text>
                        )}
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
            </FormControl>
            <HStack spacing={4}>
              <Checkbox isChecked={tools} onChange={(event) => setTools(event.target.checked)}>
                工具调用
              </Checkbox>
              <Checkbox isChecked={streaming} onChange={(event) => setStreaming(event.target.checked)}>
                流式输出
              </Checkbox>
            </HStack>
            <Box>
              <Text fontSize="12px" fontWeight={550} mb={1}>
                供应商成本（美元/百万 Token{costRequired ? "，必填" : "，可选"}）
              </Text>
              <SimpleGrid columns={2} gap={2}>
                {costKeys.map((key) => (
                  <Input
                    key={key}
                    aria-label={`供应商${key}`}
                    type="number"
                    min={0}
                    step="0.000001"
                    placeholder={
                      key === "inputUsdPerMillion"
                        ? "输入"
                        : key === "outputUsdPerMillion"
                          ? "输出"
                          : key === "cacheReadUsdPerMillion"
                            ? "缓存读取"
                            : "缓存写入"
                    }
                    value={cost[key]}
                    onChange={(event) => setCost({ ...cost, [key]: event.target.value })}
                  />
                ))}
                <Input
                  aria-label="供应商请求超时"
                  type="number"
                  min={1}
                  max={3600}
                  placeholder="超时秒数"
                  value={cost.timeoutSeconds}
                  onChange={(event) => setCost({ ...cost, timeoutSeconds: event.target.value })}
                />
              </SimpleGrid>
            </Box>
            <Box>
              <Text fontSize="12px" fontWeight={550} mb={1}>
                平台价格（可选，元/百万 Token）
              </Text>
              <SimpleGrid columns={2} gap={2}>
                {priceKeys.map((key) => (
                  <Input
                    key={key}
                    aria-label={`初始${priceLabels[key]}单价`}
                    type="number"
                    min={0}
                    step="0.000001"
                    placeholder={priceLabels[key]}
                    value={price[key]}
                    onChange={(event) => setPrice({ ...price, [key]: event.target.value })}
                  />
                ))}
              </SimpleGrid>
            </Box>
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" mr={2} isDisabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            isLoading={busy}
            isDisabled={
              !providerId ||
              !name.trim() ||
              !upstream.trim() ||
              (costRequired && !costFilled)
            }
          >
            创建模型
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function RotateModal({
  api,
  provider,
  notify,
  problem,
  onClose,
  onSaved,
}: {
  api: ReturnType<typeof useAdmin>["api"];
  provider?: Provider;
  notify: (text: string) => void;
  problem: (error: unknown) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (provider) {
      setApiKey("");
      setError("");
    }
  }, [provider]);
  return (
    <Modal isOpen={!!provider} onClose={onClose}>
      <ModalOverlay />
      <ModalContent
        mx={4}
        as="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!provider) return;
          setBusy(true);
          setError("");
          void api
            .request(`/admin/llm/providers/${provider.id}/secrets`, "POST", { apiKey })
            .then(() => {
              notify("密钥已轮换；路由和会话不受影响");
              onClose();
              onSaved();
            })
            .catch((value) => {
              setError(explain(value));
              problem(value);
            })
            .finally(() => setBusy(false));
        }}
      >
        <ModalHeader>轮换供应商密钥</ModalHeader>
        <ModalCloseButton isDisabled={busy} />
        <ModalBody>
          <Stack spacing={3}>
            {error && <ErrorNote message={error} />}
            <Text fontSize="12px" color="muted">
              「{provider?.name}」的新密钥会同步到所有 ready 版本；旧密钥在新密钥确认后退休。
            </Text>
            <FormControl isRequired>
              <FormLabel>新 API Key</FormLabel>
              <Input
                aria-label="新供应商 API Key"
                type="password"
                autoComplete="new-password"
                required
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </FormControl>
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" mr={2} isDisabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" isLoading={busy} isDisabled={!apiKey.trim()}>
            轮换密钥
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
