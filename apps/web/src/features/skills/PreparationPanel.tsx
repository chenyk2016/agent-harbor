import { Badge, Box, Button, HStack, Text } from "@chakra-ui/react";
import type { Preparation } from "./types.js";
const labels: Record<string, string> = {
  queued: "等待安装",
  downloading: "下载锁定依赖",
  building: "正在安装",
  ready: "安装完成",
  failed: "安装失败",
  cancelling: "正在停止",
  cancelled: "已取消",
  reconciling: "停止待确认",
};
export function PreparationPanel({
  value,
  busy,
  cancel,
  retry,
}: {
  value: Preparation;
  busy: boolean;
  cancel(): void;
  retry(): void;
}) {
  return (
    <Box p={4} bg="canvas" borderRadius="lg">
      <HStack>
        <Badge colorScheme={value.build.state === "ready" ? "green" : "blue"}>
          {labels[value.build.state] ?? value.build.state}
        </Badge>
        <Text fontSize="sm">第 {value.build.attempt} 次安装</Text>
        <Box flex={1} />
        {value.request.state === "waiting" && (
          <Button
            size="sm"
            variant="outline"
            isDisabled={busy}
            onClick={cancel}
          >
            取消本次安装
          </Button>
        )}
        {["failed", "cancelled"].includes(value.build.state) && (
          <Button size="sm" isDisabled={busy} onClick={retry}>
            重试
          </Button>
        )}
      </HStack>
      {value.build.error && (
        <Text mt={3} color="red.700">
          {value.build.error}
        </Text>
      )}
      {value.log && (
        <Box
          as="pre"
          mt={3}
          fontSize="13px"
          whiteSpace="pre-wrap"
          maxH="180px"
          overflowY="auto"
        >
          {value.log}
        </Box>
      )}
    </Box>
  );
}
