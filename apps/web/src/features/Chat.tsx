/** 会话工作台：标题/状态、消息、工具时间线和输入区。 */
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Stack,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import {
  BookOpen,
  Code2,
  Copy,
  FileText,
  FolderOpen,
  Menu as MenuIcon,
  MoreHorizontal,
  PanelRight,
  Power,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Workbench } from "../app/use-workspace.js";
import { useWorkbench } from "../app/workbench-context.js";
import { clock, Mark, Status, StatusInline } from "../shared/ui.js";
import { Markdown } from "../shared/Markdown.js";
import { messageFeedback } from "../state/task-feedback.js";
import { isActive } from "../state/conversation-state.js";
import { Composer } from "./chat/Composer.js";
import { ToolTimeline } from "./chat/ToolTimeline.js";
import type { Message } from "../../../../src/service/types.js";

function durationOf(message: Message) {
  if (!message.startedAt) return "";
  const end = message.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - message.startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function usageOf(message: Message) {
  if (!message.result) return "";
  try {
    const outer = JSON.parse(message.result) as Record<string, unknown>;
    const inner = (outer.result ?? outer) as Record<string, unknown>;
    const usage = inner.usage as Record<string, unknown> | undefined;
    const input = Number(
      usage?.input_tokens ?? usage?.inputTokens ?? usage?.cache_read_input_tokens ?? 0,
    );
    const output = Number(usage?.output_tokens ?? usage?.outputTokens ?? 0);
    const tokens = input + output;
    const cost = Number(inner.costUsd ?? inner.cost_usd ?? NaN);
    const parts: string[] = [];
    if (tokens > 0)
      parts.push(
        tokens >= 1_000_000
          ? `${(tokens / 1_000_000).toFixed(1)}M tokens`
          : tokens >= 1000
            ? `${(tokens / 1000).toFixed(1)}k tokens`
            : `${tokens} tokens`,
      );
    if (!message.modelSnapshot && Number.isFinite(cost))
      parts.push(`≈$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`);
    return parts.join(" · ");
  } catch {
    return "";
  }
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "上午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function Chat({
  bench,
  showFiles,
  notify,
  composerRef,
  embedded = false,
  submissionBlockedReason,
  composerAction,
  onCloseEnvironment,
}: {
  bench: Workbench;
  showFiles: () => void;
  notify: (text: string) => void;
  composerRef: RefObject<HTMLTextAreaElement>;
  embedded?: boolean;
  submissionBlockedReason?: string;
  composerAction?: React.ReactNode;
  onCloseEnvironment?: () => void;
}) {
  const { work } = bench;
  const state = work.current;
  const { openNavigation, openWorkspace, openGuide } = useWorkbench();
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const active = isActive(state?.latest);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active, state?.latest?.id]);

  useLayoutEffect(() => {
    if (thread.current && stick.current)
      thread.current.scrollTop = thread.current.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
    composerRef.current?.focus();
  }, [state?.id, composerRef]);

  const suggestions = state?.detail.expertSnapshot?.examples.length
    ? state.detail.expertSnapshot.examples.map((text) => ({
        title: text,
        text,
        icon: <FileText size={19} />,
      }))
    : [
        {
          icon: <BookOpen size={19} />,
          title: "读懂这个项目",
          text: "先阅读当前项目的 README，说明用途、目录结构和入口文件。",
        },
        {
          icon: <Code2 size={19} />,
          title: "做一次代码审查",
          text: "检查工作区的代码，列出可以改进的地方，先不要修改文件。",
        },
        {
          icon: <FileText size={19} />,
          title: "整理资料",
          text: "查看工作区已有资料，帮我整理主要内容和待办事项。",
        },
      ];

  const copy = (text: string) => {
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => notify("已复制回答"))
      .catch(() => notify("复制未完成，请手动选择文本。"));
  };

  return (
    <Flex direction="column" flex={1} minH={0} minW={0} bg="canvas">
      {!embedded && (
        <Flex
          align="center"
          gap={2.5}
          h="56px"
          px={{ base: 2, md: 5 }}
          borderBottom="1px solid"
          borderColor="line"
          bg="surface"
          flexShrink={0}
        >
          <IconButton
            display={{ base: "inline-grid", lg: "none" }}
            aria-label="打开导航"
            variant="ghost"
            size="sm"
            icon={<MenuIcon size={19} />}
            onClick={openNavigation}
          />
          <Box minW={0}>
            <HStack spacing={2.5} minW={0}>
              <Heading
                fontSize="14.5px"
                fontWeight={650}
                noOfLines={1}
                letterSpacing="-.01em"
                minW={0}
              >
                {state?.detail.title ?? "新的会话"}
              </Heading>
              <StatusInline message={state?.latest} />
              {state?.latest && active && (
                <Text
                  fontSize="10.5px"
                  color="muted"
                  display={{ base: "none", sm: "block" }}
                >
                  {durationOf(state.latest)}
                </Text>
              )}
            </HStack>
            <Text fontSize="10.5px" color="muted" noOfLines={1}>
              独立工作区 · 草稿与文件自动保存
            </Text>
          </Box>
          <Box flex={1} />
          <Tooltip label="工作区">
            <IconButton
              aria-label="工作区"
              variant="ghost"
              size="sm"
              icon={<PanelRight size={18} />}
              onClick={openWorkspace}
            />
          </Tooltip>
          <Menu placement="bottom-end">
            <MenuButton
              as={IconButton}
              aria-label="更多操作"
              variant="ghost"
              size="sm"
              icon={<MoreHorizontal size={18} />}
            />
            <MenuList fontSize="13px" minW="190px">
              <MenuItem icon={<BookOpen size={15} />} onClick={openGuide}>
                使用说明
              </MenuItem>
              <MenuItem
                icon={<Copy size={15} />}
                isDisabled={!state}
                onClick={() => {
                  if (state)
                    void navigator.clipboard
                      .writeText(
                        `${location.origin}/sessions/${state.id}`,
                      )
                      .then(() => notify("已复制会话链接"))
                      .catch(() => notify("复制未完成"));
                }}
              >
                复制会话链接
              </MenuItem>
              {onCloseEnvironment && (
                <MenuItem
                  icon={<Power size={15} />}
                  isDisabled={
                    !state ||
                    state.detail.environment === "closed" ||
                    isActive(state.latest)
                  }
                  onClick={onCloseEnvironment}
                >
                  关闭工作环境
                </MenuItem>
              )}
            </MenuList>
          </Menu>
        </Flex>
      )}

      {state && state.connection !== "connected" && (
        <Alert
          status="warning"
          fontSize="12px"
          borderBottom="1px solid"
          borderColor="line"
          borderRadius={0}
          flexShrink={0}
        >
          <AlertIcon boxSize="15px" />
          <Box flex={1}>正在连接并核对状态。草稿与已保存内容保留。</Box>
          <Button size="sm" variant="ghost" onClick={() => work.reconnect()}>
            重新连接
          </Button>
        </Alert>
      )}

      <Box
        ref={thread}
        flex={1}
        minH={0}
        overflowY="auto"
        overscrollBehavior="contain"
        onScroll={() => {
          const node = thread.current!;
          stick.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 120;
        }}
      >
        <Box
          maxW="800px"
          mx="auto"
          px={{ base: 3, md: 7 }}
          py={{ base: 5, md: 7 }}
        >
          {!state?.ordered.length ? (
            <Stack
              align="center"
              textAlign="center"
              pt={{ base: 6, md: "7vh" }}
              spacing={5}
            >
              <Mark />
              <Box>
                <Heading
                  fontSize={{ base: "22px", md: "24px" }}
                  fontWeight={650}
                  letterSpacing="-.02em"
                >
                  {state
                    ? `${greeting()}，${work.userId}`
                    : "把工作交给 Agent"}
                </Heading>
                <Text
                  color="muted"
                  maxW="460px"
                  mx="auto"
                  mt={2}
                  fontSize="13.5px"
                  lineHeight={1.75}
                >
                  {state
                    ? "把一个目标交给 Agent。它会在独立工作区里完成，并把每一步和产出的文件留给你检查。"
                    : "每个会话保存独立的对话与文件，随时回来接着工作。"}
                </Text>
              </Box>
              {state ? (
                <Box w="full">
                  <Box
                    display="grid"
                    gridTemplateColumns={{
                      base: "1fr",
                      md: "repeat(3, minmax(0, 1fr))",
                    }}
                    gap={2.5}
                    mt={3}
                  >
                    {suggestions.map((item) => (
                      <Button
                        key={item.title}
                        h="auto"
                        py={3.5}
                        px={3.5}
                        variant="outline"
                        borderColor="line"
                        bg="surface"
                        whiteSpace="normal"
                        textAlign="left"
                        justifyContent="flex-start"
                        alignItems="flex-start"
                        onClick={() => {
                          work.setDraft(item.text);
                          composerRef.current?.focus();
                        }}
                      >
                        <Stack spacing={2} align="flex-start">
                          <Box color="brand.600">{item.icon}</Box>
                          <Text fontSize="13px" fontWeight={600} lineHeight={1.5}>
                            {item.title}
                          </Text>
                          <Text
                            fontSize="11.5px"
                            color="muted"
                            fontWeight={400}
                            lineHeight={1.55}
                          >
                            点击填入输入框
                          </Text>
                        </Stack>
                      </Button>
                    ))}
                  </Box>
                  {state.detail.expertSnapshot && (
                    <Text fontSize="11px" color="muted" mt={4}>
                      本会话固定使用专家「
                      {state.detail.expertSnapshot.name}」v
                      {state.detail.expertSnapshot.version}
                    </Text>
                  )}
                </Box>
              ) : (
                <Text color="muted" fontSize="13px">
                  从左栏选择会话，或回到总入口开始新的对话。
                </Text>
              )}
            </Stack>
          ) : (
            <Stack spacing={9}>
              {state.ordered.map((message) => (
                <Box key={message.record.id}>
                  <Flex justify="flex-end" mb={6}>
                    <Box
                      maxW="86%"
                      bg="brand.50"
                      border="1px solid"
                      borderColor="brand.100"
                      borderRadius="16px 16px 6px 16px"
                      px={4}
                      py={2.5}
                    >
                      <Text
                        whiteSpace="pre-wrap"
                        overflowWrap="anywhere"
                        fontSize="14.5px"
                        lineHeight={1.7}
                      >
                        {message.record.text}
                      </Text>
                    </Box>
                  </Flex>
                  <Flex gap={3.5}>
                    <Box pt="1px">
                      <Mark small />
                    </Box>
                    <Box minW={0} flex={1}>
                      <HStack mb={2.5} spacing={2}>
                        <Text fontWeight={650} fontSize="12.5px">
                          Agent Harbor
                        </Text>
                        <Text
                          fontSize="11px"
                          color="muted"
                          pl={2}
                          borderLeft="1px solid"
                          borderColor="line"
                        >
                          {message.record.activatedModelSnapshot?.deploymentName ??
                            message.record.modelSnapshot?.deploymentName ??
                            "模型未记录"}
                        </Text>
                        <Box flex={1} />
                        {message.record.startedAt && (
                          <Text fontSize="10.5px" color="muted">
                            {clock(message.record.startedAt)}
                          </Text>
                        )}
                      </HStack>

                      <ToolTimeline
                        tools={message.tools}
                        message={message.record}
                      />

                      <Markdown text={message.text} />
                      {isActive(message.record) && (
                        <HStack spacing={2} color="muted">
                          <Box>
                            <Text fontSize="13px">
                              {message.text ? "仍在执行，等待后续结果" : state.detail.environment === "starting" ? "正在准备工作环境"
                                : message.tools.length ? "工具已调用，等待后续执行结果" : "等待模型返回内容"}
                            </Text>
                            <Text fontSize="11px" mt={1}>
                              {durationOf(message.record) && `已等待 ${durationOf(message.record)} · `}
                              {Date.now() - (message.lastOutputAt ?? message.observedAt ?? Date.now()) > 45000
                                ? "暂未收到新输出；可以继续等待或停止本轮。" : "关闭页面后，已提交的任务仍会继续。"}
                            </Text>
                          </Box>
                          <HStack spacing="3px">
                            {[0, 1, 2].map((index) => (
                              <Box
                                key={index}
                                w="4px"
                                h="4px"
                                borderRadius="full"
                                bg="brand.500"
                                animation={`ah-pulse 1.1s ease-in-out ${index * 0.15}s infinite`}
                              />
                            ))}
                          </HStack>
                        </HStack>
                      )}

                      <Flex
                        align="center"
                        gap={2}
                        flexWrap="wrap"
                        mt={3.5}
                        pt={3}
                        borderTop="1px solid"
                        borderColor="line"
                      >
                        <Status message={message.record} />
                        <Text fontSize="11px" color="muted">
                          {[
                            durationOf(message.record),
                            usageOf(message.record),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                        <Box flex={1} />
                        <HStack spacing={0} opacity={0.65} _hover={{ opacity: 1 }}>
                          <Tooltip label="复制回答">
                            <IconButton
                              aria-label="复制回答"
                              size="sm"
                              variant="ghost"
                              icon={<Copy size={14} />}
                              isDisabled={!message.text}
                              onClick={() => copy(message.text)}
                            />
                          </Tooltip>
                          <Tooltip label="查看工作文件">
                            <IconButton
                              aria-label="查看工作文件"
                              size="sm"
                              variant="ghost"
                              icon={<FolderOpen size={14} />}
                              isDisabled={!state}
                              onClick={showFiles}
                            />
                          </Tooltip>
                        </HStack>
                      </Flex>

                      <MessageOutcome message={message.record} onContinue={() => {
                        if (work.draft.trim()) { notify("输入区已有草稿，已为你保留。可以编辑后发送。"); }
                        else work.setDraft(`继续完成这项任务。先检查工作区已有结果，再完成剩余部分：\n${message.record.text}`);
                        composerRef.current?.focus();
                      }} />
                      {!message.text && message.record.status === "succeeded" && (
                        <Text mt={2} color="muted" fontSize="12px">本轮已结束，没有文字回复。请检查工作文件{embedded ? "和右侧预览" : ""}。</Text>
                      )}
                    </Box>
                  </Flex>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </Box>

      <Composer
        bench={bench}
        notify={notify}
        composerRef={composerRef}
        submissionBlockedReason={submissionBlockedReason}
        action={composerAction}
      />
    </Flex>
  );
}

function MessageOutcome({ message, onContinue }: { message: Message; onContinue: () => void }) {
  const feedback = messageFeedback(message);
  if (!feedback) return null;
  return (
    <Box mt={3} p={3} bg="warnTint" borderRadius="10px" role="status">
      <Text fontSize="12px" fontWeight={600}>{feedback.title}</Text>
      <Text mt={1} fontSize="12px" color="ink2" lineHeight={1.7}>{feedback.description}</Text>
      <Button mt={2} size="xs" variant="outline" onClick={onContinue}>继续这项任务</Button>
    </Box>
  );
}
