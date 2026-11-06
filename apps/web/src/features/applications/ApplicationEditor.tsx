/** 应用编辑页：对话常驻左侧，右侧在「工作台 / 预览」之间切换。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  IconButton,
  Link,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Spinner,
  Text,
  Tooltip,
  useBreakpointValue,
} from "@chakra-ui/react";
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  Globe,
  History,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minimize2,
  Monitor,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  RefreshCw,
  Rocket,
  Smartphone,
  X,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ApplicationApi } from "../../state/application-api.js";
import { isActive } from "../../state/conversation-state.js";
import { useWorkbench } from "../../app/workbench-context.js";
import { useWorkspace } from "../../app/use-workspace.js";
import { Chat } from "../Chat.js";
import { date, Pill } from "../../shared/ui.js";
import { explain } from "../../state/errors.js";
import { ApplicationLoginSkill } from "./ApplicationLoginSkill.js";
import { VisitorUsersPanel } from "./VisitorUsersPanel.js";
import { PreviewPanel, type PreviewPhase } from "./PreviewPanel.js";
import { WorkbenchNav, type WorkbenchSection } from "./WorkbenchNav.js";
import {
  DataPanel,
  FilesPanel,
  OperationsPanel,
  PublishPanel,
  SettingsPanel,
  VersionsPanel,
} from "./EditorPanels.js";
import { AnalysisChat } from "./AnalysisChat.js";
import { ObservationPanel } from "./ObservationPanel.js";
import {
  appStatus,
  busy,
  operationError,
  phases,
  type Detail,
  type Endpoint,
} from "./labels.js";

/** 宽屏右侧主区域的显示模式：应用预览或工作台。 */
type Mode = "preview" | "workbench";
/** 窄屏单页显示区域：对话、工作台或预览，用于避免多个区域挤在同一屏幕。 */
type Pane = "chat" | "workbench" | "preview";

/** 从路由取得应用编号，并以编号隔离编辑器状态，切换应用时重新建立本地资源。 */
export function ApplicationRoute() {
  const { appId } = useParams();
  return appId ? <ApplicationEditor key={appId} id={appId} /> : null;
}

/** 应用编辑页协调组件：关联专用消息 API、对话状态、版本轮询、预览及工作台操作。 */
function ApplicationEditor({ id }: { id: string }) {
  const context = useWorkbench();
  const { notify, problem } = context;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const reportId = params.get("report") ?? undefined;
  const reportSection = params.get("section") ?? undefined;
  const reportEnvironment = params.get("environment") ?? undefined;
  const reportDays = Number(params.get("days"));
  const [asking, setAsking] = useState(false);
  const [analysisEnvironment, setAnalysisEnvironment] = useState<"preview" | "production">("production");
  const wide = useBreakpointValue({ base: false, app: true }) ?? false;
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("preview");
  const [section, setSection] = useState<WorkbenchSection>("analysis");
  const [pane, setPane] = useState<Pane>("preview");
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (params.get("workbench") !== "analysis") return;
    setSection("analysis");
    setMode("workbench");
    setPane("workbench");
    setFocused(false);
  }, [params]);
  const [mobile, setMobile] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const head = useRef<string | null>(null);
  const mounted = useRef(false);
  const detailRequest = useRef<AbortController | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const listOwner = context.bench.work;

  // 让消息 API 绑定当前应用，并从 ref 读取最新源码头；重试身份由 ApplicationApi 固定。
  const api = useMemo(() => {
    const value = new ApplicationApi(id, () => head.current);
    value.bindUser(listOwner.userId);
    return value;
  }, [id, listOwner.userId]);
  const grantPreview = useCallback(async (deploymentId: string, signal: AbortSignal) => {
    const { exchangeUrl, ticket } = await api.request<{ exchangeUrl: string; ticket: string }>(
      `/applications/${id}/preview-access`, "POST", { deploymentId }, signal);
    const response = await fetch(exchangeUrl, {
      method: "POST", body: ticket, credentials: "include", redirect: "error", signal,
    });
    if (response.status !== 204) throw new Error("APPLICATION_PREVIEW_ACCESS_REQUIRED");
  }, [api, id]);
  /** 登录过期时重新加载页面，交回全局身份流程处理。 */
  const expired = useCallback(() => location.reload(), []);
  const bench = useWorkspace(api, listOwner.userId, expired, notify, listOwner);

  // 操作后刷新必须在操作响应之后发出，旧轮询响应不能覆盖新详情。
  const load = useCallback(async () => {
    if (!mounted.current) return;
    detailRequest.current?.abort();
    const request = new AbortController();
    detailRequest.current = request;
    try {
      const value = await api.request<Detail>(`/applications/${id}`, "GET", undefined, request.signal);
      if (request.signal.aborted) return;
      head.current = value.app.headRevisionId;
      listOwner.rememberApplication(value.app);
      setDetail(value);
      setError("");
    } catch (error) {
      if (request.signal.aborted) return;
      setError(explain(error));
      throw error;
    } finally {
      if (detailRequest.current === request) detailRequest.current = null;
    }
  }, [api, id, listOwner]);

  useEffect(() => {
    mounted.current = true;
    void load().catch(() => {});
    return () => {
      mounted.current = false;
      detailRequest.current?.abort();
    };
  }, [load]);

  const conversation = bench?.work.current;
  const chatting = !!conversation?.submitting || isActive(conversation?.latest);
  const fastRefresh = pending || chatting || !!detail?.operations.some(operation =>
    busy(operation) && operation.state !== "reconciling",
  );
  const wasChatting = useRef(false);
  useEffect(() => {
    if (wasChatting.current && !chatting) void load().catch(() => {});
    wasChatting.current = chatting;
  }, [chatting, load]);

  useEffect(() => {
    const refreshDetail = () => {
      if (!detailRequest.current) void load().catch(() => {});
    };
    const foreground = () => {
      if (!document.hidden) refreshDetail();
    };
    // 详情访问也为预览续期，空闲可见时保留低频刷新。
    const timer = setInterval(fastRefresh ? refreshDetail : foreground, fastRefresh ? 1500 : 60_000);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [fastRefresh, load]);

  const sessionId = detail?.app.developmentSessionId;
  useEffect(() => {
    if (bench && sessionId && bench.work.selectedId !== sessionId)
      void bench.work.select(sessionId);
  }, [bench, sessionId]);

  useEffect(() => {
    if (!focused) return;
    /** 响应 Escape 键退出专注预览，恢复编辑器原布局。 */
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocused(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focused]);

  const initialPane = useRef(false);
  useEffect(() => {
    if (initialPane.current || wide || !detail) return;
    initialPane.current = true;
    const running = detail.operations.some(
      (operation) =>
        busy(operation) &&
        ["create", "generate", "restore", "snapshot"].includes(operation.kind),
    );
    if (running) setPane("chat");
  }, [detail, wide]);

  useEffect(() => {
    if (!wide) setFocused(false);
  }, [wide]);

  /** 统一提交带请求编号的应用操作，处理页面忙状态、错误和操作后的详情刷新。 */
  const act = async (path: string, body: Record<string, unknown>) => {
    setPending(true);
    try {
      await api.request(`/applications/${id}/${path}`, "POST", {
        ...body,
        clientRequestId: crypto.randomUUID(),
      });
      await load();
    } catch (value) {
      problem(value);
    } finally {
      setPending(false);
    }
  };

  /** 打开指定工作台分区，并退出专注预览；窄屏同时切到工作台页面。 */
  const showSection = useCallback(
    (value: WorkbenchSection) => {
      setSection(value);
      setMode("workbench");
      setFocused(false);
      if (!wide) setPane("workbench");
    },
    [wide],
  );

  /** 为继续修改准备对话输入并切回对话区域，不直接重发上一轮生成请求。 */
  const continueEditing = useCallback(() => {
    if (!bench || !bench.work.current) return;
    if (!bench.work.draft.trim())
      bench.work.setDraft(
        "继续完成上一次未完成的应用修改。先检查工作区已有文件，再完成剩余需求并验证。",
      );
    if (!wide) setPane("chat");
    window.setTimeout(() => composer.current?.focus(), 0);
  }, [bench, wide]);

  /** 将界面问题整理成用户可编辑的需求草稿，供下一轮对话排查。 */
  const diagnose = useCallback(
    (text: string) => {
      if (!bench) return;
      bench.work.setDraft(text);
      if (!wide) setPane("chat");
      window.setTimeout(() => composer.current?.focus(), 0);
    },
    [bench, wide],
  );

  if (!detail)
    return error ? (
      <Alert status="error" m={6}>
        <AlertIcon />
        {error}
      </Alert>
    ) : (
      <Spinner m={8} />
    );

  const preview = detail.endpoints.find(
    (endpoint) => endpoint.environment === "preview",
  )!;
  const production = detail.endpoints.find(
    (endpoint) => endpoint.environment === "production",
  )!;
  const sourceBusy = detail.operations.some(
    (operation) =>
      busy(operation) &&
      ["create", "generate", "restore", "snapshot"].includes(operation.kind),
  );
  const productionBusy = detail.operations.some(
    (operation) =>
      busy(operation) &&
      ["publish", "rollback", "unpublish"].includes(operation.kind),
  );
  const previewBusy = detail.operations.some(
    (operation) => busy(operation) && operation.kind === "preview",
  );
  /** 把源码版本编号换成面向用户的递增版本号，用于预览和发布提示。 */
  const version = (revisionId?: string | null) =>
    detail.revisions.find((revision) => revision.id === revisionId)?.number;
  /** 从入口已应用部署查找对应源码版本，避免把最新源码误显示为当前运行版本。 */
  const endpointVersion = (endpoint: Endpoint) =>
    version(
      detail.deployments.find(
        (deployment) => deployment.id === endpoint.appliedDeploymentId,
      )?.revisionId,
    );
  const headVersion = version(detail.app.headRevisionId);
  const previewVersion = endpointVersion(preview);
  const productionVersion = endpointVersion(production);
  const latestGeneration = detail.operations.find(
    (operation) => operation.kind === "generate",
  );
  const latestPreview = detail.operations.find(
    (operation) => operation.kind === "preview" &&
      operation.payload?.revisionId === detail.app.headRevisionId,
  );
  const sourceOperation = detail.operations.find(
    (operation) =>
      busy(operation) &&
      ["create", "generate", "restore", "snapshot"].includes(operation.kind),
  );
  const failedGeneration =
    latestGeneration &&
    ["failed", "cancelled", "reconciling"].includes(latestGeneration.state)
      ? latestGeneration
      : undefined;
  const previewMatchesHead =
    preview.state === "ready" &&
    detail.deployments.find(
      (deployment) => deployment.id === preview.appliedDeploymentId,
    )?.revisionId === detail.app.headRevisionId;
  const failedPreview =
    !previewMatchesHead &&
    latestPreview &&
    ["failed", "cancelled", "reconciling"].includes(latestPreview.state)
      ? latestPreview
      : undefined;
  const updated = detail.revisions[0]?.createdAt;
  const versionLine = [
    headVersion ? `v${headVersion}` : "无版本",
    `预览 ${previewVersion ? `v${previewVersion}` : "未就绪"}`,
    `线上 ${productionVersion ? `v${productionVersion}` : "未发布"}`,
    updated ? `更新于 ${date(updated)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const status = appStatus(detail.app.status);
  const previewPhase: PreviewPhase = sourceBusy
    ? "generating"
    : failedPreview
      ? "failed-preview"
      : previewBusy || ["provisioning", "switching"].includes(preview.state)
        ? "building"
        : failedGeneration
          ? "failed-generation"
          : ["offline", "stopped"].includes(preview.state) &&
              (preview.appliedDeploymentId ||
                detail.operations.some(
                  (operation) =>
                    operation.kind === "preview" &&
                    operation.state === "succeeded",
                ))
            ? "paused"
            : "idle";
  const publishBlocked = !detail.app.headRevisionId
    ? "还没有可发布的版本"
    : !previewMatchesHead
      ? "需先准备当前版本的预览"
      : pending || sourceBusy || productionBusy
        ? "有操作正在进行"
        : undefined;
  /** 仅在所选版本显式开放受保护入口时，请所有者确认本次部署。 */
  const deployHead = (endpoint: Endpoint) => {
    const revisionId = detail.app.headRevisionId;
    if (!revisionId) return;
    const declaration = detail.revisions.find(revision => revision.id === revisionId)?.manifest.auth;
    const confirmPublic = declaration?.mode === "public" && endpoint.publicReleaseNeedsConfirmation;
    if (confirmPublic && !window.confirm(
      endpoint.environment === "production"
        ? "发布后，正式应用将允许未登录的访客访问。确认发布为公开应用？"
        : "构建后，预览将允许未登录的访客访问。确认构建公开预览？",
    )) return;
    void act(endpoint.environment, {
      revisionId,
      expectedGeneration: endpoint.generation,
      ...(confirmPublic ? { confirmPublicRevisionId: revisionId } : {}),
    });
  };
  /** 发布已预览的源码头，并附带当前入口代次。 */
  const publish = () => {
    if (!publishBlocked) deployHead(production);
  };
  /** 为当前源码头重新请求预览构建，不重发模型生成需求。 */
  const rebuildPreview = () => {
    if (!pending && !sourceBusy) deployHead(preview);
  };
  const retryPreview = rebuildPreview;
  /** 请求暂停当前预览实例，附带入口代次；不下线正式应用。 */
  const pausePreview = () =>
    void act("pause-preview", { expectedGeneration: preview.generation });
  /** 切换预览和工作台，并同步窄屏显示区域。 */
  const changeMode = (value: Pane) => {
    if (value === "chat") {
      setPane("chat");
      return;
    }
    setMode(value);
    if (!wide) setPane(value);
    if (value !== "preview") setFocused(false);
  };

  const callout = sourceBusy ? (
    <Flex
      align="center"
      gap={2}
      px={{ base: 3, app: 4 }}
      py={2}
      bg="brand.50"
      color="brand.700"
      borderBottom="1px solid"
      borderColor="line"
      role="status"
      aria-live="polite"
      flexShrink={0}
    >
      <Spinner size="xs" />
      <Text flex={1} fontSize="12px">
        {phases[sourceOperation?.phase ?? ""] ?? "正在完善应用"}。生成结束后会自动保存版本并构建预览，可以离开页面稍后回来。
      </Text>
    </Flex>
  ) : failedGeneration && !failedPreview ? (
    <Flex
      align="center"
      gap={2}
      px={{ base: 3, app: 4 }}
      py={2}
      bg="warnTint"
      color="warnStrong"
      borderBottom="1px solid"
      borderColor="line"
      flexWrap="wrap"
      flexShrink={0}
      role="status"
    >
      <AlertTriangle size={15} />
      <Text flex={1} minW="200px" fontSize="12px">
        {operationError(failedGeneration)}
      </Text>
      <Button size="xs" variant="outline" onClick={() => showSection("operations")}>
        查看原因
      </Button>
      {failedGeneration.state === "reconciling" ? (
        <Button
          size="xs"
          variant="outline"
          isDisabled={pending}
          onClick={() => void act("reconcile", {})}
        >
          核对运行状态
        </Button>
      ) : (
        <Button size="xs" isDisabled={sourceBusy} onClick={continueEditing}>
          继续修改
        </Button>
      )}
    </Flex>
  ) : previewBusy && !failedPreview ? (
    <Flex
      align="center"
      gap={2}
      px={{ base: 3, app: 4 }}
      py={2}
      bg="brand.50"
      color="brand.700"
      borderBottom="1px solid"
      borderColor="line"
      role="status"
      flexShrink={0}
    >
      <Spinner size="xs" />
      <Text fontSize="12px">应用修改已保存，预览正在准备。构建结束后会自动显示。</Text>
    </Flex>
  ) : failedPreview ? (
    <Flex
      align="center"
      gap={2}
      px={{ base: 3, app: 4 }}
      py={2}
      bg="warnTint"
      color="warnStrong"
      borderBottom="1px solid"
      borderColor="line"
      flexWrap="wrap"
      flexShrink={0}
      role="status"
    >
      <AlertTriangle size={15} />
      <Text flex={1} minW="200px" fontSize="12px">
        {operationError(failedPreview)}
      </Text>
      <Button size="xs" variant="outline" onClick={() => showSection("operations")}>
        查看原因
      </Button>
      <Button size="xs" variant="outline" isDisabled={pending || sourceBusy} onClick={retryPreview}>
        重试预览
      </Button>
    </Flex>
  ) : null;

  const panels: Record<WorkbenchSection, React.ReactNode> = {
    analysis: <ObservationPanel api={api} id={id} onDiagnose={diagnose}
      reportId={reportId} reportSection={reportSection} initialEnvironment={reportEnvironment} initialDays={reportDays}
      onLive={() => setParams({ workbench: "analysis" })} />,
    data: <DataPanel key={id} api={api} id={id} />,
    users: <VisitorUsersPanel key={id} api={api} id={id} preview={preview} production={production} />,
    versions: (
      <VersionsPanel
        detail={detail}
        act={act}
        pending={pending}
        sourceBusy={sourceBusy}
      />
    ),
    publish: (
      <PublishPanel
        detail={detail}
        production={production}
        act={act}
        pending={pending}
        productionBusy={productionBusy}
      />
    ),
    files:
      bench && bench.work.current ? (
        <FilesPanel bench={bench} />
      ) : (
        <Spinner m={8} />
      ),
    operations: (
      <OperationsPanel
        detail={detail}
        act={act}
        pending={pending}
        onRefresh={() => load().catch(problem)}
      />
    ),
    settings: (
      <SettingsPanel
        bench={context.bench}
        onDeleted={()=>{notify("应用已永久删除");navigate("/applications");}}
        api={api}
        app={detail.app}
        changed={load}
        problem={problem}
        notify={notify}
      />
    ),
  };

  return (
    <Flex direction="column" flex={1} minW={0} minH={0}>
      <Flex
        as="header"
        px={{ base: 3, app: 4 }}
        py={{ base: 2, app: 0 }}
        minH="52px"
        align="center"
        gap={2}
        bg="surface"
        borderBottom="1px solid"
        borderColor="line"
        flexWrap="wrap"
        flexShrink={0}
      >
        <Flex align="center" gap={2} minW={0} order={1} flexShrink={1}>
          <Flex
            w="32px"
            h="32px"
            borderRadius="9px"
            bgGradient="linear(to-br, #005BB5, #0A84FF)"
            color="white"
            align="center"
            justify="center"
            fontSize="13px"
            fontWeight={650}
            flexShrink={0}
            aria-hidden
          >
            {detail.app.title.slice(0, 1).toUpperCase()}
          </Flex>
          <Box minW={0}>
            <HStack spacing={1.5} minW={0}>
              <Heading
                as="h1"
                fontSize="14.5px"
                fontWeight={650}
                letterSpacing="-.01em"
                noOfLines={1}
                minW={0}
              >
                {detail.app.title}
              </Heading>
              <IconButton
                aria-label="修改应用名称"
                variant="ghost"
                size="xs"
                icon={<Pencil size={12} />}
                onClick={() => showSection("settings")}
              />
              <Pill tone={status.tone} pulse={status.pulse}>
                {status.label}
              </Pill>
            </HStack>
            <Text fontSize="11.5px" color="muted" noOfLines={1}>
              {versionLine}
            </Text>
          </Box>
        </Flex>

        <ModeSwitch wide={wide} mode={mode} pane={pane} onChange={changeMode} />

        {mode === "preview" && (
          <Flex
            order={{ base: 6, app: 3 }}
            w={{ base: "100%", app: "auto" }}
            flex={{ app: "0 1 440px" }}
            minW={{ app: "240px" }}
            h="32px"
            align="center"
            gap={1}
            px={2}
            border="1px solid"
            borderColor="line"
            borderRadius="8px"
            bg="surface"
          >
            <Globe size={12} color="var(--ah-muted)" />
            <Text
              flex={1}
              minW={0}
              noOfLines={1}
              fontFamily="mono"
              fontSize="10.5px"
              color="muted"
            >
              {preview.state === "ready"
                ? preview.url
                : "预览准备完成后显示访问地址"}
            </Text>
            <Tooltip label="刷新预览">
              <IconButton
                aria-label="刷新预览"
                variant="ghost"
                size="xs"
                icon={<RefreshCw size={13} />}
                isDisabled={preview.state !== "ready"}
                onClick={() => setRefresh((value) => value + 1)}
              />
            </Tooltip>
            <Tooltip label={mobile ? "桌面视图" : "手机视图"}>
              <IconButton
                aria-label={mobile ? "切换桌面视图" : "切换手机视图"}
                variant="ghost"
                size="xs"
                icon={mobile ? <Monitor size={13} /> : <Smartphone size={13} />}
                onClick={() => setMobile((value) => !value)}
              />
            </Tooltip>
            <Tooltip label="新窗口打开">
              <IconButton
                as={Link}
                href={preview.state === "ready" ? preview.url : undefined}
                isExternal
                aria-label="新窗口打开预览"
                variant="ghost"
                size="xs"
                icon={<ExternalLink size={13} />}
                isDisabled={preview.state !== "ready"}
              />
            </Tooltip>
            <Tooltip label={focused ? "退出专注预览" : "专注预览"}>
              <IconButton
                display={{ base: "none", app: "inline-flex" }}
                aria-label={focused ? "退出专注预览" : "专注预览"}
                variant="ghost"
                size="xs"
                icon={focused ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                onClick={() => setFocused((value) => !value)}
              />
            </Tooltip>
            <Menu placement="bottom-end">
              <MenuButton
                as={IconButton}
                aria-label="更多预览操作"
                variant="ghost"
                size="xs"
                icon={<MoreHorizontal size={14} />}
              />
              <MenuList>
                <MenuItem
                  icon={<RefreshCw size={13} />}
                  isDisabled={
                    pending || sourceBusy || !detail.app.headRevisionId || previewBusy
                  }
                  onClick={rebuildPreview}
                >
                  重新构建
                </MenuItem>
                <MenuItem
                  icon={<PauseCircle size={13} />}
                  isDisabled={pending || preview.state !== "ready"}
                  onClick={pausePreview}
                >
                  暂停预览
                </MenuItem>
              </MenuList>
            </Menu>
          </Flex>
        )}

        <Box flex={1} order={4} />
        <HStack order={5} spacing={1.5} ml="auto" flexShrink={0}>
          <Tooltip label="当前源码版本">
            <Badge display={{ base: "none", md: "inline-flex" }} bg="sunken" color="ink2">
              {headVersion ? `v${headVersion}` : "无版本"}
            </Badge>
          </Tooltip>
          <Tooltip label="操作记录">
            <IconButton
              display={{ base: "none", md: "inline-flex" }}
              aria-label="操作记录"
              variant="ghost"
              size="sm"
              icon={<History size={15} />}
              onClick={() => showSection("operations")}
            />
          </Tooltip>
          <PublishActions
            version={headVersion}
            reason={publishBlocked}
            onPublish={publish}
            production={production}
            notify={notify}
          />
          <Tooltip label="返回应用列表">
            <IconButton
              aria-label="返回应用列表"
              variant="ghost"
              size="sm"
              icon={<X size={17} />}
              onClick={() => navigate("/applications")}
            />
          </Tooltip>
        </HStack>
      </Flex>

      {callout}
      {error && (
        <Alert status="warning" fontSize="12px" borderRadius="0" flexShrink={0}>
          <AlertIcon boxSize="14px" />
          连接中断，正在重试。
        </Alert>
      )}

      <Flex flex={1} minH={0} overflow="hidden">
        <Flex
          display={{
            base: pane === "chat" ? "flex" : "none",
            app: focused ? "none" : "flex",
          }}
          w={{ base: "100%", app: "32%" }}
          minW={{ app: "360px" }}
          maxW={{ app: "480px" }}
          direction="column"
          minH={0}
          borderRight={{ app: "1px solid" }}
          borderColor="line"
        >
          {detail.analysisEnabled && (
            <HStack px={3} pt={2}>
              <Button size="xs" variant={!asking ? "tint" : "ghost"} onClick={() => setAsking(false)}>改应用</Button>
              <Button size="xs" variant={asking ? "tint" : "ghost"} onClick={() => setAsking(true)}>问数据</Button>
            </HStack>
          )}
          {detail.analysisEnabled && asking ? (
            <AnalysisChat key={analysisEnvironment} api={api} id={id}
              owner={context.bench.work.userId ?? ""} environment={analysisEnvironment} onEnvironment={setAnalysisEnvironment}
              onReport={(report, section, days) => setParams({ workbench: "analysis", report, section, days, environment: analysisEnvironment })} />
          ) : bench && bench.work.current ? (
            <Chat
              bench={bench}
              showFiles={() => showSection("files")}
              notify={notify}
              composerRef={composer}
              embedded
              composerAction={
                <ApplicationLoginSkill draft={bench.work.draft} onChoose={value => {
                  bench.work.setDraft(value);
                  composer.current?.focus();
                }} />
              }
              submissionBlockedReason={
                sourceBusy
                  ? "正在生成或保存应用，可以编辑草稿，当前步骤结束后再发送。"
                  : undefined
              }
            />
          ) : (
            <Spinner m={8} />
          )}
        </Flex>

        <Flex
          display={{ base: pane === "chat" ? "none" : "flex", app: "flex" }}
          flex={1}
          minW={0}
          minH={0}
          direction="column"
        >
          {mode === "preview" ? (
            <PreviewPanel
              preview={preview}
              grantPreview={grantPreview}
              previewVersion={previewVersion}
              headVersion={headVersion}
              mobile={mobile}
              refresh={refresh}
              phase={previewPhase}
              pending={pending}
              onRebuild={rebuildPreview}
              onContinue={continueEditing}
              onShowOperations={() => showSection("operations")}
            />
          ) : (
            <Flex
              flex={1}
              minW={0}
              minH={0}
              direction={{ base: "column", app: "row" }}
            >
              <WorkbenchNav value={section} onChange={showSection} />
              <Box
                flex={1}
                minW={0}
                minH={0}
                overflowY="auto"
                p={{ base: 3, app: 5 }}
              >
                {panels[section]}
              </Box>
            </Flex>
          )}
        </Flex>
      </Flex>
    </Flex>
  );
}

/** 提供预览和工作台的可访问切换按钮组，支持键盘导航。 */
function ModeSwitch({
  wide,
  mode,
  pane,
  onChange,
}: {
  wide: boolean;
  mode: Mode;
  pane: Pane;
  onChange: (value: Pane) => void;
}) {
  const active = wide ? mode : pane;
  const items = [
    { value: "chat" as const, label: "对话", icon: MessageSquare, narrow: true },
    { value: "workbench" as const, label: "工作台", icon: LayoutGrid, narrow: false },
    { value: "preview" as const, label: "预览", icon: Eye, narrow: false },
  ];
  /** 处理切换按钮的方向键和首尾键，更新焦点与选中模式。 */
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).filter((button) => button.offsetParent !== null);
    if (!buttons.length) return;
    const current = buttons.findIndex(
      (button) => button.getAttribute("aria-selected") === "true",
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowRight"
            ? (Math.max(current, 0) + 1) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
    const target = buttons[next];
    const value = target.dataset.value as Pane | undefined;
    if (value) {
      onChange(value);
      target.focus();
    }
  };
  return (
    <Flex
      role="tablist"
      aria-label="编辑模式"
      order={2}
      bg="sunken"
      p="3px"
      borderRadius="9px"
      gap="2px"
      flexShrink={0}
      onKeyDown={move}
    >
      {items.map(({ value, label, icon: Icon, narrow }) => (
        <Box
          as="button"
          type="button"
          role="tab"
          key={value}
          data-value={value}
          aria-selected={active === value}
          display={narrow ? { base: "inline-flex", app: "none" } : "inline-flex"}
          alignItems="center"
          gap={1.5}
          h="26px"
          px={2.5}
          borderRadius="7px"
          fontSize="11.5px"
          fontWeight={active === value ? 550 : 450}
          color={active === value ? "ink" : "muted"}
          bg={active === value ? "surface" : "transparent"}
          shadow={active === value ? "sm" : undefined}
          _hover={{ color: "ink" }}
          _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
          onClick={() => onChange(value)}
        >
          <Icon size={14} />
          <Text>{label}</Text>
        </Box>
      ))}
    </Flex>
  );
}

/** 展示当前正式地址与发布相关动作，根据版本和忙状态限制可执行操作。 */
function PublishActions({
  version,
  reason,
  onPublish,
  production,
  notify,
}: {
  version?: number;
  reason?: string;
  onPublish: () => void;
  production: Endpoint;
  notify: (text: string) => void;
}) {
  const label = version ? `发布 v${version}` : "发布";
  /** 复制正式应用地址并反馈结果，不改变发布状态。 */
  const copy = () => {
    if (!production.url) return;
    void navigator.clipboard
      .writeText(production.url)
      .then(() => notify("已复制线上地址"))
      .catch(() => notify("复制未完成，请手动选择地址。"));
  };
  /** 在新窗口打开已有应用地址，供用户检查独立访问效果。 */
  const open = () => {
    if (production.url)
      window.open(production.url, "_blank", "noopener,noreferrer");
  };
  return (
    <>
      <HStack spacing={0} display={{ base: "none", md: "flex" }}>
        <Tooltip label={reason} isDisabled={!reason} hasArrow>
          <Box as="span" display="inline-flex">
            <Button
              size="sm"
              borderRightRadius={0}
              isDisabled={!!reason}
              onClick={onPublish}
            >
              {label}
            </Button>
          </Box>
        </Tooltip>
        <Menu placement="bottom-end">
          <MenuButton
            as={Button}
            size="sm"
            borderLeftRadius={0}
            px={1.5}
            aria-label="发布选项"
          >
            <ChevronDown size={14} />
          </MenuButton>
          <MenuList>
            <MenuItem
              icon={<ExternalLink size={13} />}
              isDisabled={!production.url}
              onClick={open}
            >
              打开线上地址
            </MenuItem>
            <MenuItem
              icon={<Copy size={13} />}
              isDisabled={!production.url}
              onClick={copy}
            >
              复制线上地址
            </MenuItem>
          </MenuList>
        </Menu>
      </HStack>
      <Menu placement="bottom-end">
        <MenuButton
          as={IconButton}
          display={{ base: "inline-flex", md: "none" }}
          aria-label="发布"
          size="sm"
          icon={<Rocket size={15} />}
        />
        <MenuList>
          <MenuItem isDisabled={!!reason} icon={<Rocket size={13} />} onClick={onPublish}>
            {label}
          </MenuItem>
          <MenuItem
            icon={<ExternalLink size={13} />}
            isDisabled={!production.url}
            onClick={open}
          >
            打开线上地址
          </MenuItem>
          <MenuItem
            icon={<Copy size={13} />}
            isDisabled={!production.url}
            onClick={copy}
          >
            复制线上地址
          </MenuItem>
        </MenuList>
      </Menu>
    </>
  );
}
