/** 总入口：对话与应用共用一套输入框，发送即创建，不再经过创建弹窗。 */
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  IconButton,
  Kbd,
  Text,
  Textarea,
} from "@chakra-ui/react";
import {
  ArrowUp,
  LayoutGrid,
  Menu as MenuIcon,
  MessageSquare,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../../../../src/clients/service-client.js";
import { useWorkbench } from "../app/workbench-context.js";
import { ApplicationLoginSkill, applicationRequirement } from "./applications/ApplicationLoginSkill.js";
import { ModelPicker } from "./llm/ModelPicker.js";
import { explain } from "../state/errors.js";
import { draftTitle } from "../state/workspace.js";
import type { AppLink } from "../state/workspace.js";

/** 首页提交目标：普通对话或应用创建；两者共用输入区但进入不同后端流程。 */
type Mode = "chat" | "app";
/** 应用创建配置的加载结果，决定能否展示和提交应用模式。 */
type AppState = "loading" | "allowed" | "denied" | "off" | "error";

/** 创建接口返回的最小应用信息，供前端记住应用并跳转到编辑页。 */
interface CreatedApp extends AppLink {
  developmentSessionId: string | null;
}

/** 统一创建入口，收集需求和模型后创建会话或应用，并保留请求编号以安全重试。 */
export function NewEntry() {
  const { api, bench, problem, openNavigation } = useWorkbench();
  const navigate = useNavigate();
  const location = useLocation();
  const queryMode =
    new URLSearchParams(location.search).get("mode") === "app" ? "app" : "chat";
  const [mode, setMode] = useState<Mode>(queryMode);
  const [text, setText] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [appState, setAppState] = useState<AppState>("loading");
  const composer = useRef<HTMLTextAreaElement>(null);
  const request = useRef(crypto.randomUUID());
  const chatRequest = useRef(crypto.randomUUID());

  /** 输入内容或创建模式变化时更新请求身份，避免把新需求复用成旧请求。 */
  const resetRequest = () => {
    request.current = crypto.randomUUID();
    chatRequest.current = crypto.randomUUID();
  };

  useEffect(() => {
    let alive = true;
    void api
      .request<{ canCreate: boolean }>("/applications/config")
      .then((config) => {
        if (alive) setAppState(config.canCreate ? "allowed" : "denied");
      })
      .catch((value) => {
        if (!alive) return;
        if (
          value instanceof ApiError &&
          (value.status === 401 || value.code === "ACCOUNT_DISABLED")
        ) {
          problem(value);
          return;
        }
        setAppState(value instanceof ApiError && value.status === 404 ? "off" : "error");
      });
    return () => {
      alive = false;
    };
  }, [api, problem]);

  // 从列表“+”或应用画廊进来时，URL 决定模式；同一路径重复导航也要重新聚焦。
  useEffect(() => {
    setMode(queryMode);
    setError("");
    const timer = window.setTimeout(() => composer.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [queryMode, location.key]);

  useLayoutEffect(() => {
    const node = composer.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [text, mode]);

  const appReady = appState === "allowed";
  const unavailable =
    mode === "app" && !appReady;
  const appReason =
    appState === "denied"
      ? "当前账号没有创建应用的权限，请联系管理员。"
      : appState === "off"
        ? "应用创建尚未在此服务开启。"
        : appState === "error"
          ? "暂时无法读取应用创建配置，请稍后重试。"
          : "";

  /** 把认证问题交给全局登录处理，其余错误在当前输入区展示，保留用户原需求。 */
  const fail = (value: unknown) => {
    if (
      value instanceof ApiError &&
      (value.status === 401 || value.code === "ACCOUNT_DISABLED")
    ) {
      problem(value);
      return;
    }
    setError(explain(value));
  };

  /** 把当前输入提交到选定模式的创建入口；成功后跳转，失败保留内容和原请求编号供重试。 */
  async function submit() {
    const value = text.trim();
    if (!value || busy || unavailable) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "app") {
        const result = await api.request<{ app: CreatedApp }>(
          "/applications",
          "POST",
          {
            title: draftTitle(applicationRequirement(value), "我的应用"),
            prompt: value,
            modelDeploymentId: modelId || undefined,
            clientRequestId: request.current,
          },
        );
        bench.work.rememberApplication(result.app);
        setText("");
        navigate(`/applications/${result.app.id}`);
      } else {
        const id = await bench.work.startConversation(
          value,
          modelId || undefined,
          chatRequest.current,
        );
        setText("");
        navigate(`/sessions/${id}`);
      }
    } catch (value) {
      // 创建失败时保留原文，用户可直接再次发送；同一 clientRequestId 防止重复创建。
      fail(value);
    } finally {
      setBusy(false);
    }
  }

  /** 切换普通对话与应用模式，并更新该次提交的请求身份。 */
  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    resetRequest();
    if (queryMode !== next) navigate(`/?mode=${next}`, { replace: true });
    window.setTimeout(() => composer.current?.focus(), 0);
  };

  return (
    <Box flex={1} minH={0} overflowY="auto" bg="canvas">
      <Box
        maxW="860px"
        mx="auto"
        px={{ base: 4, md: 7 }}
        pt={{ base: "8vh", md: "13vh" }}
        pb={{ base: 8, md: 12 }}
      >
        <IconButton
          display={{ base: "inline-flex", lg: "none" }}
          aria-label="打开导航"
          variant="ghost"
          size="sm"
          icon={<MenuIcon size={19} />}
          onClick={openNavigation}
          mb={3}
          ml="-6px"
        />
        <Heading
          fontSize={{ base: "26px", md: "32px" }}
          fontWeight={650}
          letterSpacing="-.03em"
        >
          把目标交给 Agent
        </Heading>
        <Text
          mt={2}
          color="muted"
          fontSize="13.5px"
          lineHeight={1.75}
          maxW="560px"
        >
          {mode === "chat"
            ? "描述一个目标，Agent 会在独立工作区里拆解并推进，过程和产出文件都可检查。"
            : "用一句话描述你要的应用，Agent 会生成并打开编辑页，继续完善、预览和发布。"}
        </Text>

        <HStack
          spacing={1}
          p="3px"
          mt={6}
          bg="sunken"
          borderRadius="11px"
          display="inline-flex"
          role="tablist"
          aria-label="创建类型"
        >
          <Button
            role="tab"
            aria-selected={mode === "chat"}
            size="sm"
            variant="ghost"
            leftIcon={<MessageSquare size={15} />}
            bg={mode === "chat" ? "surface" : "transparent"}
            color={mode === "chat" ? "ink" : "muted"}
            boxShadow={mode === "chat" ? "sm" : undefined}
            fontWeight={mode === "chat" ? 600 : 500}
            onClick={() => switchMode("chat")}
            _hover={{ bg: mode === "chat" ? "surface" : "surfaceHover" }}
          >
            对话
          </Button>
          <Button
            role="tab"
            aria-selected={mode === "app"}
            size="sm"
            variant="ghost"
            leftIcon={<LayoutGrid size={15} />}
            bg={mode === "app" ? "surface" : "transparent"}
            color={mode === "app" ? "ink" : "muted"}
            boxShadow={mode === "app" ? "sm" : undefined}
            fontWeight={mode === "app" ? 600 : 500}
            isDisabled={!appReady}
            onClick={() => switchMode("app")}
            _hover={{ bg: mode === "app" ? "surface" : "surfaceHover" }}
          >
            应用
          </Button>
        </HStack>

        {appReason && (
          <Text mt={2} fontSize="11.5px" color="warnStrong">
            {appReason}
          </Text>
        )}

        <Box
          as="form"
          mt={5}
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            void submit();
          }}
          border="1px solid"
          borderColor="lineStrong"
          borderRadius="18px"
          bg="surface"
          boxShadow="sm"
          overflow="hidden"
          transition="border-color .15s, box-shadow .15s"
          _focusWithin={{
            borderColor: "brand.500",
            boxShadow: "0 0 0 3px var(--ah-focus)",
          }}
        >
          <Textarea
            ref={composer}
            aria-label={mode === "chat" ? "描述要推进的目标" : "描述要创建的应用"}
            placeholder={
              mode === "chat"
                ? "描述一个目标，我来拆解任务并推进…"
                : "例如：做一个活动报名页，收集姓名和邮箱，支持查看报名记录。"
            }
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              resetRequest();
              if (error) setError("");
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
            border={0}
            bg="transparent"
            _focusVisible={{ boxShadow: "none" }}
            resize="none"
            rows={1}
            minH={{ base: "88px", md: "104px" }}
            maxH="220px"
            fontSize="15.5px"
            lineHeight={1.75}
            px={4}
            pt={4}
            pb={2}
            overflowY="auto"
          />

          <Flex align="center" gap={2} px={3} pb={3} flexWrap="wrap">
            <Box
              display={{ base: "none", md: "block" }}
              w={{ md: "220px", lg: "260px" }}
              flexShrink={0}
            >
              <ModelPicker
                api={api}
                value={modelId}
                onChange={(value) => {
                  setModelId(value);
                  resetRequest();
                }}
                compact
                inline
              />
            </Box>
            {mode === "app" && appReady && (
              <ApplicationLoginSkill draft={text} disabled={busy} onChoose={value => {
                setText(value);
                resetRequest();
                setError("");
                composer.current?.focus();
              }} />
            )}
            <Box flex={1} />
            <HStack
              spacing="5px"
              fontSize="10.5px"
              color="muted"
              display={{ base: "none", md: "flex" }}
            >
              <Kbd fontSize="9px">Enter</Kbd>
              <Text>发送</Text>
            </HStack>
            <Button
              type="submit"
              size="sm"
              borderRadius="10px"
              ml="auto"
              leftIcon={<ArrowUp size={15} />}
              isLoading={busy}
              isDisabled={!text.trim() || unavailable}
            >
              {mode === "chat" ? "开始对话" : "创建应用"}
            </Button>
          </Flex>
        </Box>

        {error && (
          <Alert
            mt={3}
            status="error"
            borderRadius="10px"
            fontSize="12.5px"
            role="alert"
          >
            <AlertIcon boxSize="15px" />
            <Box flex={1}>{error}</Box>
          </Alert>
        )}

        <Text mt={3} fontSize="10.5px" color="muted" lineHeight={1.7}>
          {mode === "chat"
            ? "发送后会创建会话并立即开始执行；首次发送才准备工作环境。"
            : "创建后直接打开应用编辑页；应用名称取自需求首行，可随时改名。"}
          {" "}Shift + Enter 换行。
        </Text>
      </Box>
    </Box>
  );
}
