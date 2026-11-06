/** 工作区概览：状态、环境、专家/技能和会话元信息；不复制会话列表数据。 */
import {
  Box,
  Button,
  Divider,
  Flex,
  HStack,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Power, RefreshCw, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { Workbench } from "../../app/use-workspace.js";
import type { Environment } from "../../../../../src/service/types.js";
import {
  date,
  environments,
  Hint,
  Pill,
  SectionLabel,
  Status,
  type Tone,
} from "../../shared/ui.js";
import { isActive } from "../../state/conversation-state.js";
import { Activity } from "./Activity.js";

const envTone = (env: Environment): Tone =>
  env === "ready" ? "teal" : env === "closed" ? "neutral" : "amber";

function duration(seconds: number) {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function useElapsed(start: number | null | undefined, end: number | null | undefined, active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!start) return null;
  return Math.max(0, Math.round(((active ? now : (end ?? now)) - start) / 1000));
}

export function Overview({
  bench,
  closeEnvironment,
}: {
  bench: Workbench;
  closeEnvironment: () => void;
}) {
  const state = bench.work.current;
  if (!state) return <Hint>选择会话后查看详情。</Hint>;
  const expert = state.detail.expertSnapshot;
  const skills = state.detail.capabilitySnapshot?.skills ?? [];
  const active = isActive(state.latest);
  const seconds = useElapsed(
    state.latest?.startedAt,
    state.latest?.finishedAt,
    active,
  );

  return (
    <Stack spacing={5}>
      <Box
        border="1px solid"
        borderColor="line"
        borderRadius="14px"
        p="12px 13px"
        bg="surfaceHover"
      >
        <HStack spacing={2} align="center">
          <Status message={state.latest} />
          {seconds !== null && (
            <Text ml="auto" fontSize="11px" color="muted">
              {duration(seconds)}
            </Text>
          )}
        </HStack>
        <Text fontSize="11px" color="muted" mt={2} lineHeight={1.6}>
          {active
            ? "本轮执行中。可以继续编辑下一条草稿，或停止本轮。"
            : "本轮结束后请检查实际结果。关闭页面不会取消已提交任务。"}
        </Text>
      </Box>

      <Box>
        <SectionLabel>工作环境</SectionLabel>
        <Box
          border="1px solid"
          borderColor="line"
          borderRadius="10px"
          p="10px 11px"
        >
          <HStack spacing={2}>
            <Text fontSize="11.5px" color="muted" minW="52px">
              状态
            </Text>
            <Box flex={1} textAlign="right">
              <Pill tone={envTone(state.detail.environment)}>
                {environments[state.detail.environment]}
              </Pill>
            </Box>
          </HStack>
          <Divider my="7px" />
          <Flex justify="space-between" fontSize="11.5px">
            <Text color="muted">空闲回收</Text>
            <Text color="ink2">15 分钟</Text>
          </Flex>
          <Flex justify="space-between" fontSize="11.5px" mt={1.5}>
            <Text color="muted">镜像</Text>
            <Text color="ink2" fontFamily="mono" fontSize="10.5px">
              agent-harbor
            </Text>
          </Flex>
        </Box>
        <Flex direction="column" gap={1.5} mt={2.5}>
          <Button
            size="sm"
            variant="outline"
            justifyContent="flex-start"
            leftIcon={<Power size={14} />}
            isDisabled={
              state.connection !== "connected" ||
              !!state.control ||
              state.detail.environment === "closed"
            }
            onClick={closeEnvironment}
          >
            关闭工作环境
          </Button>
          <Button
            size="sm"
            variant="ghost"
            justifyContent="flex-start"
            leftIcon={<RefreshCw size={14} />}
            isDisabled={
              state.connection !== "connected" ||
              !!state.control ||
              isActive(state.latest)
            }
            onClick={() =>
              void bench.work.reloadMcp(
                state.id,
                state.detail.lastMessageId,
              )
            }
          >
            重新加载 MCP
          </Button>
        </Flex>
        <Text fontSize="10.5px" color="muted" mt={2} lineHeight={1.6}>
          关闭环境会停止容器进程，对话和文件保留。只想结束当前任务，请用「停止本轮」。
        </Text>
      </Box>

      <Divider />

      {(expert || skills.length > 0) && (
        <Box>
          <SectionLabel>专家与技能</SectionLabel>
          {expert && (
            <Flex
              align="center"
              gap={2.5}
              p="10px 11px"
              bg="brand.50"
              borderRadius="10px"
              mb={skills.length ? 2 : 0}
            >
              <Flex
                w="30px"
                h="30px"
                borderRadius="full"
                bg="surface"
                color="brand.700"
                align="center"
                justify="center"
                fontSize="12.5px"
                fontWeight={600}
                flexShrink={0}
              >
                {expert.name.slice(0, 1)}
              </Flex>
              <Box minW={0}>
                <Text fontSize="12px" fontWeight={600} noOfLines={1}>
                  {expert.name} · v{expert.version}
                </Text>
                <Text fontSize="10.5px" color="ink2" mt="1px">
                  创建时固定，关闭环境后仍使用这一版。
                </Text>
              </Box>
            </Flex>
          )}
          {skills.length > 0 && (
            <Box
              border="1px solid"
              borderColor="line"
              borderRadius="10px"
              px="11px"
              py="4px"
            >
              {skills.map((skill) => (
                <Flex
                  key={skill.versionId}
                  align="center"
                  gap={2}
                  py="6px"
                  borderBottom="1px solid"
                  borderColor="line"
                  _last={{ borderBottom: 0 }}
                  fontSize="11.5px"
                >
                  <Terminal size={12} color="var(--ah-muted)" />
                  <Text flex={1} minW={0} noOfLines={1}>
                    {skill.name}
                  </Text>
                  <Text
                    fontFamily="mono"
                    fontSize="10px"
                    color="muted"
                    flexShrink={0}
                  >
                    /{skill.invocationName}
                  </Text>
                </Flex>
              ))}
            </Box>
          )}
        </Box>
      )}

      <Divider />

      <Box>
        <SectionLabel>最近动态</SectionLabel>
        <Activity state={state} />
      </Box>

      <Divider />

      <Box>
        <SectionLabel>会话</SectionLabel>
        <Flex justify="space-between" fontSize="11.5px" py="2px">
          <Text color="muted">创建</Text>
          <Text color="ink2">{date(state.detail.createdAt)}</Text>
        </Flex>
        <Flex justify="space-between" fontSize="11.5px" py="2px">
          <Text color="muted">模型</Text>
          <Text color="ink2" noOfLines={1} maxW="70%" textAlign="right">
            {state.detail.modelSnapshot?.deploymentName ?? "未记录"}
          </Text>
        </Flex>
        <Flex justify="space-between" fontSize="11.5px" py="2px" gap={2}>
          <Text color="muted" flexShrink={0}>
            编号
          </Text>
          <Text
            color="ink2"
            fontFamily="mono"
            fontSize="10px"
            noOfLines={1}
          >
            {state.detail.id}
          </Text>
        </Flex>
      </Box>
    </Stack>
  );
}
