/** 输入区：Enter 发送、附件 chip、拖拽上传；执行中只换成停止按钮。 */
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Link,
  Text,
  Textarea,
  Tooltip,
} from "@chakra-ui/react";
import { ArrowUp, FileText, Paperclip, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Workbench } from "../../app/use-workspace.js";
import { environments } from "../../shared/ui.js";
import { isActive } from "../../state/conversation-state.js";
import { ComposerModelPicker } from "../llm/ComposerModelPicker.js";

const jobLabels = {
  preparing: "校验中",
  uploading: "上传中",
  ready: "已上传",
  unknown: "待确认",
  failed: "失败",
};

function envTone(environment: string) {
  if (environment === "ready") return "var(--ah-ok)";
  if (environment === "closed") return "var(--ah-line-strong)";
  return "var(--ah-warn)";
}

export function Composer({
  bench,
  notify,
  composerRef,
  submissionBlockedReason,
  action,
}: {
  bench: Workbench;
  notify: (text: string) => void;
  composerRef: RefObject<HTMLTextAreaElement>;
  submissionBlockedReason?: string;
  action?: React.ReactNode;
}) {
  const { work, files, canUpload } = bench;
  const state = work.current;
  const busy = isActive(state?.latest);
  const blocked =
    !state ||
    state.connection !== "connected" ||
    !!state.control ||
    ["stopping", "reconciling"].includes(state.detail.environment);
  const draft = work.draft;
  const [modelValid, setModelValid] = useState(false);
  const [dragging, setDragging] = useState(false);
  const chooser = useRef<HTMLInputElement>(null);
  const target = useRef<{ sessionId: string; files: Workbench["files"] }>();

  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 196)}px`;
  }, [draft, state?.id, composerRef]);

  function choose() {
    if (!state || !canUpload()) return;
    target.current = { sessionId: state.id, files };
    chooser.current?.click();
  }

  function chosen(selected: File[]) {
    const original = target.current;
    target.current = undefined;
    if (
      !original ||
      original.sessionId !== work.selectedId ||
      original.files !== files
    ) {
      notify("会话已切换，请在目标会话重新选择文件。");
      return;
    }
    if (selected.length) void files.upload(selected);
  }

  const jobs = files.currentJobs;
  const expert = state?.detail.expertSnapshot;

  return (
    <Box
      px={{ base: 3, md: 7 }}
      pt={1}
      pb={{ base: 3, md: 4 }}
      flexShrink={0}
      bg="canvas"
    >
      <Box maxW="800px" mx="auto">
        {state?.error && (
          <Alert mb={2} status="error" borderRadius="9px" fontSize="12px" role="alert">
            <AlertIcon boxSize="14px" />
            <Box>{state.error}
              {(/费用|余额|额度/.test(state.error)) && <Link href="/settings/account" display="block" mt={1} textDecoration="underline">查看余额与费用明细</Link>}
            </Box>
          </Alert>
        )}
        {work.pending ? (
          <Alert mb={2} status="warning" borderRadius="9px" fontSize="12px">
            <AlertIcon boxSize="14px" />
            <Box flex={1}>提交结果待确认，原文和请求编号已保留。</Box>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={blocked || busy || state?.submitting}
              onClick={() => void work.send(true)}
            >
              核对并重试
            </Button>
          </Alert>
        ) : null}

        <Box
          as="form"
          position="relative"
          onSubmit={(event: React.FormEvent) => {
            event.preventDefault();
            if (!submissionBlockedReason && modelValid && !blocked) void work.send();
          }}
          onDragOver={(event: React.DragEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canUpload()) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: React.DragEvent<HTMLFormElement>) => {
            event.preventDefault();
            setDragging(false);
            if (!canUpload()) return;
            const selected = [...event.dataTransfer.files];
            if (selected.length) void files.upload(selected);
          }}
          border="1px solid"
          borderColor={dragging ? "brand.500" : "lineStrong"}
          rounded="18px"
          bg="surface"
          boxShadow="sm"
          overflow="hidden"
          transition="border-color .15s, box-shadow .15s"
          _focusWithin={{
            borderColor: "brand.500",
            boxShadow: "0 0 0 3px var(--ah-focus)",
          }}
        >
          {!!jobs.length && (
            <Flex wrap="wrap" gap="6px" px={3} pt={2.5}>
              {jobs.slice(0, 4).map((job) => (
                <HStack
                  key={job.id}
                  spacing="6px"
                  maxW="220px"
                  h="26px"
                  px="8px"
                  borderRadius="7px"
                  border="1px solid"
                  borderColor="line"
                  bg="surfaceHover"
                  fontSize="11px"
                  color="ink2"
                >
                  <FileText size={12} color="var(--ah-muted)" />
                  <Text noOfLines={1} maxW="120px">
                    {job.name}
                  </Text>
                  <Text
                    color={
                      job.status === "failed"
                        ? "dangerStrong"
                        : job.status === "ready"
                          ? "ok"
                          : "muted"
                    }
                    flexShrink={0}
                  >
                    {jobLabels[job.status]}
                  </Text>
                </HStack>
              ))}
              {jobs.length > 4 && (
                <Text fontSize="10.5px" color="muted" alignSelf="center">
                  还有 {jobs.length - 4} 个
                </Text>
              )}
            </Flex>
          )}

          {action && <Box px={3} pt={2}>{action}</Box>}
          <Textarea
            ref={composerRef}
            aria-label="消息内容"
            placeholder={
              state
                ? "描述你的任务，或把文件拖进来…"
                : "新建或选择一个会话后开始"
            }
            value={draft}
            onChange={(event) => work.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (!submissionBlockedReason && modelValid && !blocked) void work.send();
              }
            }}
            isDisabled={!state}
            border={0}
            bg="transparent"
            _focusVisible={{ boxShadow: "none" }}
            _disabled={{ opacity: 1 }}
            resize="none"
            rows={1}
            minH="46px"
            maxH="196px"
            fontSize="15px"
            lineHeight={1.7}
            px={3.5}
            pt={3}
            pb={1}
            overflowY="auto"
          />

          <Flex align="center" gap={1} px={2.5} pb={2.5}>
            <Tooltip label="上传资料">
              <IconButton
                aria-label="上传资料"
                variant="ghost"
                size="sm"
                icon={<Paperclip size={17} />}
                isDisabled={!canUpload()}
                onClick={choose}
              />
            </Tooltip>
            <Tooltip label={state ? environments[state.detail.environment] : "尚未选择会话"}>
              <HStack
                spacing="5px"
                h="28px"
                px="7px"
                borderRadius="7px"
                fontSize="11.5px"
                color="ink2"
                _hover={{ bg: "surfaceHover" }}
                cursor="default"
                display={{ base: "none", sm: "flex" }}
              >
                <Box
                  w="5px"
                  h="5px"
                  borderRadius="full"
                  bg={state ? envTone(state.detail.environment) : "lineStrong"}
                />
                <Text>
                  {state
                    ? state.detail.environment === "closed"
                      ? "发送后自动准备"
                      : environments[state.detail.environment]
                    : "尚未选择会话"}
                </Text>
              </HStack>
            </Tooltip>
            {expert && (
              <HStack
                spacing="5px"
                h="28px"
                px="7px"
                borderRadius="7px"
                fontSize="11.5px"
                color="ink2"
                display={{ base: "none", md: "flex" }}
              >
                <UsersIcon />
                <Text noOfLines={1} maxW="100px">
                  {expert.name}
                </Text>
              </HStack>
            )}
            <Box flex={1} />
            <ComposerModelPicker work={work} onValidity={setModelValid} />
            {busy ? (
              <Button
                size="sm"
                variant="danger"
                leftIcon={<Square size={12} />}
                isDisabled={blocked || !!state?.latest?.cancelRequested}
                onClick={() => void work.cancel()}
              >
                {state?.control === "cancel" || state?.latest?.cancelRequested
                  ? "正在停止"
                  : "停止"}
              </Button>
            ) : (
              <IconButton
                aria-label="发送消息"
                icon={<ArrowUp size={18} />}
                type="submit"
                isLoading={state?.submitting}
                isDisabled={
                  blocked ||
                  !!submissionBlockedReason ||
                  !modelValid ||
                  !!work.pending ||
                  files.busy(state?.id ?? "") ||
                  !draft.trim()
                }
                borderRadius="10px"
                w="34px"
                h="34px"
                minW="34px"
                bg="brand.500"
                color="onBrand"
                _hover={{ bg: "brand.600" }}
                _active={{ bg: "brand.700" }}
                _disabled={{
                  bg: "sunken",
                  color: "muted",
                  cursor: "not-allowed",
                }}
              />
            )}
          </Flex>

          {dragging && (
            <Flex
              position="absolute"
              inset={0}
              bg="brand.50"
              border="2px dashed"
              borderColor="brand.400"
              borderRadius="18px"
              align="center"
              justify="center"
              fontSize="13px"
              fontWeight={550}
              color="brand.700"
              pointerEvents="none"
            >
              松开以上传文件
            </Flex>
          )}
        </Box>

        <Text
          textAlign="center"
          mt={2}
          fontSize="10.5px"
          color="muted"
          lineHeight={1.6}
        >
          {submissionBlockedReason && !busy ? submissionBlockedReason : busy
            ? "任务执行中，可以继续编辑下一条草稿。"
            : state?.connection !== "connected"
              ? "连接中断，可以继续编辑草稿，恢复后再发送。"
              : work.pending
                ? "提交结果待确认，请先核对再继续。"
                : "Enter 发送 · Shift + Enter 换行 · 关闭页面不会停止已提交的任务"}
        </Text>

        <input
          ref={chooser}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            chosen([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </Box>
    </Box>
  );
}

function UsersIcon() {
  return (
    <Box as="svg" w="13px" h="13px" color="var(--ah-muted)" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Box>
  );
}
