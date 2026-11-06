import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  SimpleGrid,
  Text,
} from "@chakra-ui/react";
import { NavLink } from "react-router";
import { Sparkles, Wallet } from "lucide-react";
import { PageHeader } from "../shell/PageHeader.js";
import { useWorkbench } from "../../app/workbench-context.js";
import type { ModelCatalog } from "../../../../../src/shared/llm.js";
export function ModelsPage() {
  const { api, problem, notify } = useWorkbench();
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    const c = await api.request<ModelCatalog>("/llm/models");
    setCatalog(c);
  };
  useEffect(() => {
    void load().catch((e) => {
      setError("无法加载模型，请重试。");
      problem(e);
    });
  }, [api]);
  const action = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError("操作未确认，请刷新核对状态；不要重复添加。");
      problem(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box
        maxW="1120px"
        mx="auto"
        px={{ base: 4, md: 8 }}
        py={{ base: 5, md: 7 }}
      >
        <PageHeader
          title="模型"
          subtitle="选择新会话的默认模型；当前对话可在输入框内切换。"
          actions={
            <Button
              as={NavLink}
              to="/settings/account"
              variant="outline"
              size="sm"
              leftIcon={<Wallet size={14} />}
            >
              用量与余额
            </Button>
          }
        />
        {error && (
          <Alert status="error" fontSize="12px" borderRadius="9px" mb={4}>
            <AlertIcon boxSize="14px" />
            {error}
          </Alert>
        )}
        {catalog && !catalog.enabled && (
          <Alert status="info" fontSize="12px" borderRadius="9px" mb={4}>
            <AlertIcon boxSize="14px" />
            此服务尚未启用 LiteLLM 网关，请按部署指南配置。
          </Alert>
        )}
        {catalog?.enabled && (
          <Box>
            <Text
              fontSize="10.5px"
              fontWeight={600}
              letterSpacing=".04em"
              color="muted"
              mb={2}
            >
              可用模型
            </Text>
            {catalog.models.length === 0 ? (
              <Text fontSize="12.5px" color="muted">
                暂无可用模型，请联系管理员添加并同步。
              </Text>
            ) : (
              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={2.5}>
                {catalog.models.map((m) => {
                  const current = catalog.defaultModelId === m.id;
                  return (
                    <Box
                      key={m.id}
                      border="1px solid"
                      borderColor="line"
                      borderRadius="14px"
                      bg="surface"
                      p={4}
                    >
                      <Flex gap={2.5} align="flex-start">
                        <Flex
                          w="32px"
                          h="32px"
                          borderRadius="9px"
                          bg={current ? "brand.50" : "sunken"}
                          color={current ? "brand.600" : "ink2"}
                          align="center"
                          justify="center"
                          flexShrink={0}
                        >
                          <Sparkles size={16} />
                        </Flex>
                        <Box minW={0} flex={1}>
                          <Text
                            fontSize="13.5px"
                            fontWeight={600}
                            noOfLines={1}
                          >
                            {m.name}
                          </Text>
                          <Text fontSize="10.5px" color="muted" mt="2px">
                            {m.provider} ·{" "}
                            {m.description || "工具调用 / 流式输出"}
                          </Text>
                        </Box>
                        {current && (
                          <Badge bg="okTint" color="ok">
                            当前默认
                          </Badge>
                        )}
                      </Flex>
                      <Flex
                        align="center"
                        mt={3}
                        pt={2.5}
                        borderTop="1px solid"
                        borderColor="line"
                      >
                        <Text fontSize="10.5px" color="muted">
                          新会话默认模型
                        </Text>
                        <Box flex={1} />
                        <Button
                          size="sm"
                          variant={current ? "ghost" : "outline"}
                          isDisabled={busy || current}
                          onClick={() =>
                            void action(async () => {
                              await api.request("/llm/default", "PUT", {
                                deploymentId: m.id,
                              });
                              notify("已设为新会话默认模型");
                            })
                          }
                        >
                          {current ? "当前默认" : "设为默认"}
                        </Button>
                      </Flex>
                    </Box>
                  );
                })}
              </SimpleGrid>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
