/** 应用画廊：展示最近应用；创建统一走首页入口，编辑页由 ApplicationEditor 承载。 */
import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  SimpleGrid,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { Link as RouteLink, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import { useWorkbench } from "../../app/workbench-context.js";
import { DeleteResourceButton } from "../deletions/DeleteResource.js";
import { PageHeader } from "../shell/PageHeader.js";
import { appStatus, appStatusColors, type AppRecord } from "./labels.js";

/** 读取当前用户应用列表与创建权限，展示应用画廊，并提供继续编辑和删除入口。 */
export function ApplicationsPage() {
  const { api, problem, bench } = useWorkbench();
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [enabled, setEnabled] = useState<boolean>();
  const [canCreate, setCanCreate] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string>();

  useEffect(() => {
    let alive = true;
    void api
      .request<{ enabled: boolean; canCreate: boolean; reason?: string }>("/applications/config")
      .then(async (config) => {
        if (config.enabled === false) {
          if (alive) {
            setEnabled(false);
            setCanCreate(false);
            setUnavailableReason(config.reason);
          }
          return;
        }
        const records = await api.request<AppRecord[]>("/applications");
        if (alive) {
          setEnabled(true);
          setCanCreate(config.canCreate);
          setApps(records);
          // 同一次读取同时供给会话列表的类型图标与点击分流。
          bench.work.rememberApplications(records);
        }
      })
      .catch((error) => {
        if (alive) {
          setEnabled(false);
          if (error.status !== 404) problem(error);
        }
      });
    return () => {
      alive = false;
    };
  }, [api, bench, problem]);

  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box maxW="1120px" mx="auto" px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }}>
        <PageHeader
          title="我的应用"
          subtitle="用一句话创建，持续对话完善，再发布给其他人使用。"
          showNavigation={false}
          actions={
            canCreate ? (
              <Button
                size="sm"
                leftIcon={<Plus size={14} />}
                onClick={() => navigate("/?mode=app")}
              >
                新建应用
              </Button>
            ) : undefined
          }
        />
        {enabled === undefined ? (
          <Spinner />
        ) : !enabled ? (
          <Alert status="info" fontSize="12px" borderRadius="9px">
            <AlertIcon boxSize="14px" />
            应用创建暂不可用。{unavailableReason && ` ${unavailableReason}`}
          </Alert>
        ) : (
          <>
            {!canCreate && (
              <Alert status="info" fontSize="12px" borderRadius="9px" mb={5}>
                <AlertIcon boxSize="14px" />
                当前账号没有创建权限，请联系管理员。
              </Alert>
            )}

            <HStack spacing={2} mb={3} align="baseline">
              <Text fontSize="13.5px" fontWeight={650}>
                最近应用
              </Text>
              <Text fontSize="11.5px" color="muted">
                {apps.length}
              </Text>
            </HStack>
            {apps.length ? (
              <SimpleGrid columns={{ base: 1, sm: 2, xl: 4 }} spacing={3}>
                {apps.map((app, index) => {
                  const meta = appStatus(app.status);
                  const tone = appStatusColors(app.status);
                  const tints = [
                    "linear(to-br, brand.50, surface)",
                    "linear(to-br, okTint, surface)",
                    "linear(to-br, warnTint, surface)",
                    "linear(to-br, sunken, surface)",
                  ];
                  return (
                    <Box
                      key={app.id}
                      border="1px solid"
                      borderColor="line"
                      borderRadius="14px"
                      bg="surface"
                      overflow="hidden"
                      transition="border-color .15s, box-shadow .15s"
                      _hover={{ borderColor: "lineStrong", boxShadow: "sm" }}
                      _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
                    >
                      <Box as={RouteLink} to={`/applications/${app.id}`} display="block">
                      <Box
                        h="112px"
                        bgGradient={tints[index % tints.length]}
                        position="relative"
                        px={3.5}
                        pt={3.5}
                        borderBottom="1px solid"
                        borderColor="line"
                      >
                        <Box h="6px" w="34%" bg="brand.500" opacity={0.8} borderRadius="3px" mb={2} />
                        <Box h="5px" w="64%" bg="lineStrong" borderRadius="3px" mb="6px" />
                        <Box h="5px" w="42%" bg="lineStrong" borderRadius="3px" />
                        <Box
                          position="absolute"
                          left={3.5}
                          right={3.5}
                          bottom="10px"
                          h="30px"
                          bg="surface"
                          border="1px solid"
                          borderColor="line"
                          borderRadius="7px"
                        />
                      </Box>
                      <Box p={3.5}>
                        <Flex align="center" gap={2}>
                          <Text fontSize="13.5px" fontWeight={600} noOfLines={1} flex={1}>
                            {app.title}
                          </Text>
                          <Badge bg={tone.bg} color={tone.color} flexShrink={0}>
                            {meta.label}
                          </Badge>
                        </Flex>
                        <Text fontSize="10.5px" color="muted" mt="6px">
                          {app.status === "deleting" ? "删除未完成，可继续删除" : "打开继续编辑"}
                        </Text>
                      </Box>
                      </Box>
                      <Box px={3.5} pb={3.5}><DeleteResourceButton target={{kind:"application",id:app.id,title:app.title,sessionId:app.developmentSessionId}} bench={bench} onDeleted={()=>setApps(items=>items.filter(item=>item.id!==app.id))}/></Box>
                    </Box>
                  );
                })}
              </SimpleGrid>
            ) : (
              <Text color="muted" fontSize="12.5px">
                还没有应用。
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
