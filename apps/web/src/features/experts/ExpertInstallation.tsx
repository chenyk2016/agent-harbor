import { Badge, Box, Button, HStack, Stack, Text } from "@chakra-ui/react";
import type { Installation, SkillChoice } from "./types.js";
const labels: Record<string, string> = {
  installing: "正在安装",
  ready: "已安装，可开始对话",
  failed: "安装未完成",
  cancelling: "正在取消",
  cancelled: "已取消",
  queued: "等待安装",
  downloading: "下载依赖",
  building: "安装中",
  reconciling: "停止待确认",
};
export function ExpertInstallation({
  value,
  choices,
  busy,
  cancel,
  retry,
}: {
  value: Installation;
  choices: SkillChoice[];
  busy: boolean;
  cancel(): void;
  retry(requestId: string, attempt: number): void;
}) {
  return (
    <Box p={5} borderWidth="1px" borderColor="line" borderRadius="xl">
      <HStack mb={value.items.length ? 4 : 0}>
        <Badge colorScheme={value.state === "ready" ? "green" : "blue"}>
          {labels[value.state]}
        </Badge>
        <Box flex={1} />
        {value.state === "installing" && (
          <Button
            size="sm"
            variant="outline"
            isDisabled={busy}
            onClick={cancel}
          >
            取消本次专家安装
          </Button>
        )}
      </HStack>
      {!value.items.length && (
        <Text fontSize="sm" mt={3} color="muted">
          无需安装额外技能。Claude 默认技能继续可用。
        </Text>
      )}
      <Stack spacing={4}>
        {value.items.map((item) => (
          <Box key={item.request.id}>
            <HStack flexWrap="wrap">
              <Text flex={1}>
                {item.name ??
                  choices.find((choice) => choice.id === item.versionId)
                    ?.name ??
                  "技能"}
              </Text>
              <Text fontSize="sm" color="muted">
                {item.build.state === "ready"
                  ? "已安装"
                  : (labels[item.build.state] ?? item.build.state)}
              </Text>
              {value.status === "active" &&
                ["failed", "cancelled"].includes(item.request.state) &&
                !["cancelling", "reconciling"].includes(item.build.state) && (
                  <Button
                    size="sm"
                    isDisabled={busy}
                    onClick={() => retry(item.request.id, item.build.attempt)}
                  >
                    重试此技能
                  </Button>
                )}
            </HStack>
            {item.build.error && (
              <Text mt={2} color="red.600" fontSize="sm">
                {item.build.error}
              </Text>
            )}
            {item.log && (
              <Box
                as="pre"
                mt={2}
                fontSize="13px"
                whiteSpace="pre-wrap"
                maxH="160px"
                overflowY="auto"
              >
                {item.log}
              </Box>
            )}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
