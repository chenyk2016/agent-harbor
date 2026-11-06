/** 账户与用量：额度、token、费用和钱包；数据来自 /account。 */
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  HStack,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import { useWorkbench } from "../../app/workbench-context.js";
import { PageHeader } from "../shell/PageHeader.js";
import { bytes, Hint, SectionLabel } from "../../shared/ui.js";
import { explain } from "../../state/workspace.js";
import { WalletPanel } from "../wallet/WalletPanel.js";

interface AccountData {
  user: { id: string; name: string };
  counts: { sessions: number; tasks: number; environments: number };
  limits: {
    sessions: number;
    tasks: number;
    environments: number;
    workspaceBytes: number;
  };
  workspaceBytes: number;
  messages: number;
  usage: {
    estimatedUsd: number;
    observedResults: number;
    measuredMessages: number;
    mainInputTokens: number;
    mainOutputTokens: number;
  };
}

function quotaPercent(used: number, limit: number) {
  if (!limit) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function AccountUsage() {
  const { api, problem } = useWorkbench();
  const [data, setData] = useState<AccountData>();
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void api
      .request<AccountData>("/account", "GET", undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setData(value);
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setError(explain(error));
          problem(error);
        }
      });
    return () => abort.abort();
  }, [api, problem, version]);

  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box maxW="1040px" mx="auto" px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }}>
        <PageHeader
          title="账户与用量"
          subtitle="用量按消息记录，费用是网关估算，不是账单。"
          actions={
            <>
              <Button
                as={NavLink}
                to="/settings/keys"
                variant="outline"
                size="sm"
                leftIcon={<KeyRound size={14} />}
              >
                访问密钥
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<RefreshCw size={14} />}
                onClick={() => refresh((n) => n + 1)}
              >
                刷新
              </Button>
            </>
          }
        />

        {error && (
          <Alert status="error" borderRadius="9px" mb={4} fontSize="12px">
            <AlertIcon boxSize="14px" />
            {error}
          </Alert>
        )}
        {!data ? (
          <Spinner />
        ) : (
          <Stack spacing={4}>
            <Flex align="center" gap={3}>
              <Flex
                w="44px"
                h="44px"
                borderRadius="12px"
                bg="brand.50"
                color="brand.600"
                align="center"
                justify="center"
                fontSize="17px"
                fontWeight={600}
                flexShrink={0}
              >
                {data.user.name.slice(0, 1).toUpperCase()}
              </Flex>
              <Box minW={0}>
                <Text fontSize="16px" fontWeight={650}>
                  {data.user.name}
                </Text>
                <Text fontSize="10.5px" color="muted" fontFamily="mono" mt="1px">
                  用户 ID · {data.user.id}
                </Text>
              </Box>
            </Flex>

            <SimpleGrid
              columns={{ base: 1, sm: 2, md: 4 }}
              spacing={2.5}
            >
              {[
                {
                  label: "保存会话",
                  value: data.counts.sessions,
                  limit: data.limits.sessions,
                },
                {
                  label: "执行任务",
                  value: data.counts.tasks,
                  limit: data.limits.tasks,
                },
                {
                  label: "保留环境",
                  value: data.counts.environments,
                  limit: data.limits.environments,
                },
              ].map((item) => (
                <Box
                  key={item.label}
                  p="11px 12px"
                  border="1px solid"
                  borderColor="line"
                  borderRadius="10px"
                  bg="surface"
                >
                  <Text fontSize="10.5px" color="muted">
                    {item.label}
                  </Text>
                  <Text fontSize="17px" fontWeight={650} mt="2px">
                    {item.value}
                    <Text as="span" fontSize="11px" color="muted" ml="4px">
                      / {item.limit}
                    </Text>
                  </Text>
                  <Box h="3px" bg="sunken" borderRadius="99px" mt="8px" overflow="hidden">
                    <Box
                      h="100%"
                      w={`${quotaPercent(item.value, item.limit)}%`}
                      bg={
                        quotaPercent(item.value, item.limit) >= 100
                          ? "warn"
                          : "brand.500"
                      }
                      borderRadius="99px"
                    />
                  </Box>
                </Box>
              ))}
              <Box
                p="11px 12px"
                border="1px solid"
                borderColor="line"
                borderRadius="10px"
                bg="surface"
              >
                <Text fontSize="10.5px" color="muted">
                  工作文件
                </Text>
                <Text fontSize="15px" fontWeight={650} mt="2px">
                  {bytes(data.workspaceBytes)}
                  <Text as="span" fontSize="11px" color="muted" ml="4px">
                    / {bytes(data.limits.workspaceBytes)}
                  </Text>
                </Text>
                <Box h="3px" bg="sunken" borderRadius="99px" mt="8px" overflow="hidden">
                  <Box
                    h="100%"
                    w={`${quotaPercent(data.workspaceBytes, data.limits.workspaceBytes)}%`}
                    bg="brand.500"
                    borderRadius="99px"
                  />
                </Box>
              </Box>
            </SimpleGrid>

            <Box
              p="16px 18px"
              border="1px solid"
              borderColor="line"
              borderRadius="14px"
              bg="surface"
            >
              <Flex align="flex-start" gap={4} flexWrap="wrap">
                <Box>
                  <Text fontSize="10.5px" color="muted">
                    已记录估算费用
                  </Text>
                  <Text fontSize="24px" fontWeight={650} letterSpacing="-.02em" mt="2px">
                    ${data.usage.estimatedUsd.toFixed(4)}
                  </Text>
                </Box>
                <Box flex={1} />
                <Box textAlign="right">
                  <Text fontSize="10.5px" color="muted">
                    已提交消息
                  </Text>
                  <Text fontSize="13px" fontWeight={600} mt="2px">
                    {data.messages} 条
                  </Text>
                </Box>
              </Flex>
              <SimpleGrid columns={{ base: 1, sm: 3 }} spacing={3} mt={4} pt={3} borderTop="1px solid" borderColor="line">
                <Box>
                  <Text fontSize="10.5px" color="muted">
                    主循环输入
                  </Text>
                  <Text fontSize="13px" fontWeight={600}>
                    {data.usage.mainInputTokens.toLocaleString()} tokens
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="10.5px" color="muted">
                    主循环输出
                  </Text>
                  <Text fontSize="13px" fontWeight={600}>
                    {data.usage.mainOutputTokens.toLocaleString()} tokens
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="10.5px" color="muted">
                    已观测结果
                  </Text>
                  <Text fontSize="13px" fontWeight={600}>
                    {data.usage.observedResults} / {data.usage.measuredMessages}
                  </Text>
                </Box>
              </SimpleGrid>
              <Text fontSize="10.5px" color="muted" mt={3} lineHeight={1.6}>
                费用是 SDK 估算，不是账单；文件空间是软额度，不含运行日志和模型状态。
              </Text>
            </Box>

            <Box>
              <SectionLabel>钱包</SectionLabel>
              <WalletPanel api={api} />
            </Box>

            <Hint>
              额度由管理员配置。接近上限时，新的任务或环境会被拒绝，不会自动排队。
            </Hint>
          </Stack>
        )}
      </Box>
    </Box>
  );
}
