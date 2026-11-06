/** 预览画布：居中白色画框、桌面/手机两种宽度，以及未就绪和过期提示。 */
import { Box, Button, Flex, HStack, Spinner, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { AlertTriangle, Monitor } from "lucide-react";
import { EmptyState } from "./EditorChrome.js";
import type { Endpoint } from "./labels.js";

/** 预览区的展示阶段，区分代码生成、构建、暂停以及生成失败和预览失败。 */
export type PreviewPhase =
  | "generating"
  | "building"
  | "failed-generation"
  | "failed-preview"
  | "paused"
  | "idle";

/** 根据入口与源码版本展示真实预览或阶段提示；旧预览仍运行时明确显示与最新源码的差异。 */
export function PreviewPanel({
  preview,
  previewVersion,
  headVersion,
  mobile,
  refresh,
  phase,
  pending,
  onRebuild,
  onContinue,
  onShowOperations,
}: {
  preview: Endpoint;
  previewVersion?: number;
  headVersion?: number;
  mobile: boolean;
  refresh: number;
  phase: PreviewPhase;
  pending: boolean;
  onRebuild: () => void;
  onContinue: () => void;
  onShowOperations: () => void;
}) {
  const ready = preview.state === "ready";
  const embedded = ready && preview.requiresLogin && preview.previewParentOrigin === window.location.origin;
  const embeddedUrl = embedded ? preview.url : undefined;
  const workbenchUrl = preview.previewParentOrigin && !embedded
    ? new URL(window.location.pathname, preview.previewParentOrigin).href : undefined;
  const deployment = preview.appliedDeploymentId;
  const probeKey = embeddedUrl ? `${embeddedUrl}:${deployment}:${refresh}` : undefined;
  const [probe, setProbe] = useState<{ key: string; state: "signed-in" | "login" | "failed" }>();
  const session = probe && probe.key === probeKey ? probe.state : undefined;

  useEffect(() => {
    if (!embeddedUrl || !probeKey) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch(new URL("__harbor/auth/embedded-session", embeddedUrl), {
          credentials: "include",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (!controller.signal.aborted)
          setProbe({ key: probeKey, state: response.status === 204 ? "signed-in" : response.status === 401 ? "login" : "failed" });
      } catch {
        if (!controller.signal.aborted) setProbe({ key: probeKey, state: "failed" });
      }
    };
    void check();
    const timer = window.setInterval(check, 60000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [embeddedUrl, probeKey]);
  const outdated =
    ready && headVersion !== undefined && previewVersion !== headVersion;
  const copy =
    phase === "generating"
      ? "左侧会记录模型输出和工具调用。生成结束后会自动保存版本并构建预览，你可以离开页面，稍后回来查看。"
      : phase === "building"
        ? "应用修改已保存。构建结束后，预览会自动出现在这里。"
        : phase === "paused"
          ? "预览实例已暂停。重新构建后可以继续在当前版本上体验。"
          : phase === "failed-generation" || phase === "failed-preview"
            ? "需求和已保存的文件还在。查看原因后可以继续修改；已有版本也可以在版本记录里查看。"
            : "在左侧描述你要解决的问题。先生成和体验，再把确认过的版本发布给其他人。";
  const title =
    phase === "generating"
      ? "正在生成应用"
      : phase === "building"
        ? "正在准备预览"
        : phase === "paused"
          ? "预览已暂停"
          : phase === "failed-generation"
            ? "这次生成还没完成"
            : phase === "failed-preview"
              ? "预览还没有准备好"
              : "让你的想法在这里成形";
  const busyState = phase === "generating" || phase === "building";
  const failedState =
    phase === "failed-generation" || phase === "failed-preview";
  const failedGeneration = phase === "failed-generation";

  return (
    <Flex direction="column" flex={1} minW={0} minH={0}>
      {outdated && (
        <Flex
          align="center"
          gap={2}
          px={4}
          py={2}
          bg="brand.50"
          color="brand.700"
          fontSize="12px"
          borderBottom="1px solid"
          borderColor="line"
          flexShrink={0}
        >
          <AlertTriangle size={14} />
          <Text flex={1}>
            当前显示 v{previewVersion ?? "—"} 预览。v{headVersion}
            {phase === "failed-preview"
              ? " 预览未能部署。"
              : phase === "building"
                ? " 预览正在准备。"
                : " 预览尚未准备。"}
          </Text>
          {phase === "failed-preview" ? (
            <Button size="xs" variant="tint" onClick={onShowOperations}>查看原因</Button>
          ) : (
            <Button size="xs" variant="tint" isDisabled={pending || busyState} onClick={onRebuild}>
              构建 v{headVersion}
            </Button>
          )}
        </Flex>
      )}
      <Box
        flex={1}
        minH={0}
        bg="sunken"
        p={{ base: 3, app: 5 }}
        display="flex"
        justifyContent="center"
        overflow="auto"
      >
        <Box
          w={mobile ? "390px" : "100%"}
          maxW={mobile ? "100%" : "1200px"}
          h="100%"
          minH="480px"
          flexShrink={0}
          bg="white"
          border="1px solid"
          borderColor="line"
          borderRadius={mobile ? "20px" : "12px"}
          shadow={mobile ? "md" : "sm"}
          overflow="hidden"
        >
          {embedded && !session ? (
            <Flex h="100%" align="center" justify="center" role="status">
              <Spinner size="sm" mr={2} /> 正在检查预览登录
            </Flex>
          ) : embedded && session === "login" ? (
            <Flex h="100%" align="center" justify="center">
              <EmptyState
                icon={<Monitor size={20} />}
                title="登录后体验预览"
                description="使用此应用的测试账号，登录后会自动回到这里。"
                action={<Button as="a" href={new URL("__harbor/auth/start?workbench=1", preview.url).href}>登录测试账号</Button>}
              />
            </Flex>
          ) : ready && preview.requiresLogin && session !== "signed-in" ? (
            <Flex h="100%" align="center" justify="center">
              <EmptyState
                icon={<Monitor size={20} />}
                title="登录后体验预览"
                description={workbenchUrl ? "切换到 HTTPS 工作台，就能在这里登录并使用预览。" :
                  session === "failed" ? "暂时无法读取预览登录状态。可以独立打开预览。" : "预览有独立的测试账号，请在新窗口打开。"}
                action={workbenchUrl
                  ? <Button as="a" href={workbenchUrl}>前往 HTTPS 工作台</Button>
                  : <Button as="a" href={preview.url} target="_blank" rel="noopener noreferrer">打开预览</Button>}
              />
            </Flex>
          ) : ready ? (
            <Box
              as="iframe"
              title="应用预览"
              key={`${preview.appliedDeploymentId}:${refresh}`}
              src={preview.url}
              sandbox="allow-scripts allow-forms allow-same-origin"
              border={0}
              display="block"
              w="100%"
              h="100%"
              bg="white"
            />
          ) : (
            <Flex h="100%" minH="480px" align="center" justify="center" bg="white">
              <EmptyState
                icon={busyState ? <Spinner size="sm" /> : <Monitor size={20} />}
                title={title}
                description={copy}
                action={
                  <HStack spacing={2}>
                    {failedGeneration ? (
                      <Button size="sm" isDisabled={pending} onClick={onContinue}>
                        继续完善应用
                      </Button>
                    ) : phase === "paused" ? (
                      <Button size="sm" isDisabled={pending} onClick={onRebuild}>
                        重新构建
                      </Button>
                    ) : failedState ? (
                      <Button size="sm" isDisabled={pending} onClick={onRebuild}>
                        重试预览
                      </Button>
                    ) : (
                      !busyState && (
                        <Button size="sm" onClick={onContinue}>
                          继续完善应用
                        </Button>
                      )
                    )}
                    {failedState && (
                      <Button size="sm" variant="outline" onClick={onShowOperations}>
                        查看原因
                      </Button>
                    )}
                  </HStack>
                }
              />
            </Flex>
          )}
        </Box>
      </Box>
    </Flex>
  );
}
