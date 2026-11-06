/** 工作区动态：沿用状态层已经整理好的事件描述，不另造进度。 */
import { Box, Flex, Text } from "@chakra-ui/react";
import type { ConversationState } from "../../state/conversation-state.js";

function colorOf(text: string) {
  if (text.includes("结束") || text.includes("完成")) return "ok";
  if (text.includes("调用") || text.includes("开始")) return "brand.500";
  if (text.includes("停止") || text.includes("中断")) return "warn";
  if (text.includes("失败")) return "danger";
  return "lineStrong";
}

export function Activity({ state }: { state: ConversationState }) {
  const items = state.activity.slice(0, 12);
  if (!items.length)
    return (
      <Text fontSize="12px" color="muted">
        尚无执行记录。
      </Text>
    );
  return (
    <Box position="relative" pl="16px">
      <Box
        position="absolute"
        left="4px"
        top="4px"
        bottom="4px"
        w="1px"
        bg="line"
      />
      {items.map((text, index) => (
        <Flex key={`${index}-${text}`} position="relative" pb={3} gap={2}>
          <Box
            position="absolute"
            left="-15px"
            top="5px"
            w="7px"
            h="7px"
            borderRadius="full"
            bg={colorOf(text)}
            boxShadow="0 0 0 2px var(--ah-surface)"
          />
          <Text fontSize="11.5px" color="ink2" lineHeight={1.55}>
            {text}
          </Text>
        </Flex>
      ))}
    </Box>
  );
}
