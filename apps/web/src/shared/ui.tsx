/** 展示型小组件；状态颜色和文案只从这里出，避免页面各写一套。 */
import { Box, HStack, Text } from "@chakra-ui/react";
import { messageStatusLabel } from "../state/task-feedback.js";
import { Anchor } from "lucide-react";
import type { Message, Environment } from "../../../../src/service/types.js";

export const statuses: Record<Message["status"], string> = {
  accepted: "正在执行",
  running: "正在执行",
  finalizing: "正在执行",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
  interrupted: "执行中断",
  reconciling: "结果待确认",
};

export const environments: Record<Environment, string> = {
  closed: "环境已关闭",
  ready: "环境可用",
  starting: "准备环境中",
  stopping: "正在关闭",
  reconciling: "状态待确认",
};

export const date = (time: number) =>
  new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export const clock = (time: number) =>
  new Date(time).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

export const bytes = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 ** 2
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 ** 2).toFixed(1)} MiB`;

export type Tone = "blue" | "teal" | "red" | "amber" | "neutral";

const toneMap: Record<Tone, { color: string; bg: string }> = {
  blue: { color: "brand.600", bg: "brand.50" },
  teal: { color: "ok", bg: "okTint" },
  red: { color: "dangerStrong", bg: "dangerTint" },
  amber: { color: "warnStrong", bg: "warnTint" },
  neutral: { color: "ink2", bg: "sunken" },
};

const dotMap: Record<Tone, string> = {
  blue: "brand.500",
  teal: "ok",
  red: "danger",
  amber: "warn",
  neutral: "lineStrong",
};

export function Pill({
  tone = "neutral",
  pulse = false,
  children,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: React.ReactNode;
}) {
  const c = toneMap[tone];
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      gap="5px"
      h="22px"
      px="8px"
      borderRadius="999px"
      fontSize="11.5px"
      fontWeight={500}
      lineHeight="1"
      whiteSpace="nowrap"
      color={c.color}
      bg={c.bg}
    >
      <Box
        as="span"
        w="6px"
        h="6px"
        borderRadius="full"
        bg="currentColor"
        flexShrink={0}
        animation={pulse ? "ah-pulse 1.6s ease-in-out infinite" : undefined}
      />
      {children}
    </Box>
  );
}

export function toneOf(message?: Message | null): Tone {
  if (!message) return "neutral";
  if (message.status === "failed") return "red";
  if (message.status === "succeeded") return "teal";
  if (["accepted", "running", "finalizing"].includes(message.status))
    return "blue";
  if (message.status === "reconciling") return "amber";
  return "neutral";
}

export function isStopping(message?: Message | null) {
  return Boolean(
    message?.cancelRequested &&
      ["accepted", "running", "finalizing"].includes(message.status),
  );
}

export function Status({ message }: { message?: Message | null }) {
  const tone = toneOf(message);
  const label = message
    ? isStopping(message)
      ? "正在停止"
      : messageStatusLabel(message) ?? statuses[message.status]
    : "等待开始";
  return (
    <Pill tone={tone} pulse={tone === "blue"}>
      {label}
    </Pill>
  );
}

export function StatusDot({ message }: { message?: Message | null }) {
  const tone = toneOf(message);
  return (
    <Box
      w="7px"
      h="7px"
      borderRadius="full"
      bg={dotMap[tone]}
      flexShrink={0}
      animation={
        tone === "blue" ? "ah-pulse 1.6s ease-in-out infinite" : undefined
      }
    />
  );
}

export function StatusInline({ message }: { message?: Message | null }) {
  const tone = toneOf(message);
  const label = message
    ? isStopping(message)
      ? "正在停止"
      : messageStatusLabel(message) ?? statuses[message.status]
    : "等待开始";
  return (
    <HStack spacing="5px" color={toneMap[tone].color} flexShrink={0}>
      <Box
        w="6px"
        h="6px"
        borderRadius="full"
        bg="currentColor"
        animation={
          tone === "blue" ? "ah-pulse 1.6s ease-in-out infinite" : undefined
        }
      />
      <Text fontSize="11px" color="currentColor">
        {label}
      </Text>
    </HStack>
  );
}

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <Box
      bgGradient="linear(to-br, #005BB5, #0A84FF)"
      color="white"
      display="grid"
      placeItems="center"
      borderRadius={small ? "7px" : "14px"}
      w={small ? "24px" : "46px"}
      h={small ? "24px" : "46px"}
      flexShrink={0}
      boxShadow="0 2px 6px rgba(0,113,227,.28)"
    >
      <Anchor size={small ? 14 : 24} strokeWidth={2} />
    </Box>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return (
    <Text fontSize="12px" color="muted" lineHeight={1.65}>
      {children}
    </Text>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="10.5px"
      fontWeight={600}
      letterSpacing=".04em"
      color="muted"
      mb={2}
    >
      {children}
    </Text>
  );
}
