/** 工具时间线：只展示已有事件；不伪造耗时和输出。 */
import { Box, Button, Collapse, Flex, HStack, Text } from "@chakra-ui/react";
import {
  ChevronDown,
  Edit3,
  FileText,
  Globe,
  Search,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ToolCall } from "../../state/conversation-state.js";
import type { Message } from "../../../../../src/service/types.js";

const iconOf = (name: string) => {
  if (["Read", "NotebookRead"].includes(name)) return <FileText size={12} />;
  if (["Edit", "Write", "NotebookEdit"].includes(name))
    return <Edit3 size={12} />;
  if (["Grep", "Glob", "LS"].includes(name)) return <Search size={12} />;
  if (["Bash", "BashOutput"].includes(name)) return <Terminal size={12} />;
  if (["Task", "Agent"].includes(name)) return <Users size={12} />;
  if (["WebFetch", "WebSearch"].includes(name)) return <Globe size={12} />;
  return <Wrench size={12} />;
};

const fallbackDetail = (name: string) => {
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name))
    return "文件操作";
  if (["Grep", "Glob", "LS"].includes(name)) return "工作区搜索";
  if (["Bash", "BashOutput"].includes(name)) return "运行命令";
  if (["WebFetch", "WebSearch"].includes(name)) return "访问网络";
  if (["Task", "Agent"].includes(name)) return "子任务";
  return "工具调用";
};

export function ToolTimeline({
  tools,
  message,
}: {
  tools: ToolCall[];
  message: Message;
}) {
  const active = ["accepted", "running", "finalizing"].includes(message.status);
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  if (!tools.length) return null;
  const names = [...new Set(tools.map((tool) => tool.name))].join(" · ");

  return (
    <Box
      border="1px solid"
      borderColor="line"
      borderRadius="14px"
      overflow="hidden"
      bg="surface"
      mb="14px"
    >
      <Button
        variant="ghost"
        size="sm"
        w="full"
        h="auto"
        justifyContent="flex-start"
        borderRadius={0}
        px={3}
        py="10px"
        gap={2}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {active ? (
          <Box
            w="13px"
            h="13px"
            borderRadius="full"
            border="1.8px solid"
            borderColor="brand.100"
            borderTopColor="brand.500"
            animation="ah-spin .8s linear infinite"
            flexShrink={0}
          />
        ) : (
          <Terminal size={14} color="var(--ah-muted)" />
        )}
        <Text fontSize="12.5px" fontWeight={550} color="ink">
          {active
            ? `已发起 ${tools.length} 次工具调用`
            : `已发起 ${tools.length} 次工具调用`}
        </Text>
        <Text
          fontSize="11.5px"
          color="muted"
          minW={0}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          display={{ base: "none", sm: "block" }}
        >
          {names}
        </Text>
        <Box flex={1} />
        <ChevronDown
          size={14}
          color="var(--ah-muted)"
          style={{
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform .18s",
            flexShrink: 0,
          }}
        />
      </Button>
      <Collapse in={open} animateOpacity>
        <Box borderTop="1px solid" borderColor="line" py="4px">
          <Text px={3} py={2} fontSize="11px" color="muted">以下记录表示工具已被调用，执行结果以回复和工作文件为准。</Text>
          {tools.map((tool, index) => {
            // 目前只接收tool.started，不能把调用事件当作工具成功回执。
            return (
              <Flex
                key={`${index}-${tool.name}`}
                align="flex-start"
                gap="9px"
                px="13px"
                py="7px"
              >
                <Flex
                  w="18px"
                  h="18px"
                  borderRadius="5px"
                  bg="sunken"
                  color="ink2"
                  align="center"
                  justify="center"
                  flexShrink={0}
                  mt="1px"
                >
                  {iconOf(tool.name)}
                </Flex>
                <Box minW={0} flex={1}>
                  <HStack spacing="7px" minW={0}>
                    <Text fontSize="12px" fontWeight={550} flexShrink={0}>
                      {tool.name}
                    </Text>
                    <Text
                      fontFamily="mono"
                      fontSize="11px"
                      color="muted"
                      noOfLines={1}
                    >
                      {tool.detail ?? fallbackDetail(tool.name)}
                    </Text>
                  </HStack>
                </Box>
                <Text
                  fontSize="11px"
                  color="muted"
                  flexShrink={0}
                  whiteSpace="nowrap"
                >
                  已调用
                </Text>
              </Flex>
            );
          })}
        </Box>
      </Collapse>
    </Box>
  );
}
