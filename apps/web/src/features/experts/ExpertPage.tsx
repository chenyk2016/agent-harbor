import { ModelPicker } from "../llm/ModelPicker.js";
/** 版本编辑留在页面内；安装状态属于服务，离开页面只取消读取。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Select } from "../../shared/select.js";
import {
  useBeforeUnload,
  useBlocker,
  useNavigate,
  useParams,
} from "react-router";
import { useWorkbench } from "../../app/workbench-context.js";
import { ApiError } from "../../../../../src/clients/service-client.js";
import { ExpertConnections } from "./ExpertConnections.js";
import { WorkBuddyEditor, NewWorkBuddyExpert } from "./WorkBuddyEditor.js";
import { ExpertForm } from "./ExpertForm.js";
import { ExpertInstallation } from "./ExpertInstallation.js";
import {
  emptyExpert,
  type ExpertDetail,
  type ExpertDefinition,
  type Installation,
  type SkillChoice,
} from "./types.js";
/** 切换专家编号时重建编辑页，旧请求不能覆盖新目标或抢走导航。 */
export function ExpertRoute() {
  const { expertId } = useParams();
  return expertId ? <ExpertPage key={expertId} /> : <NewWorkBuddyExpert />;
}
export function ExpertPage() {
  const { api, problem, created } = useWorkbench(),
    { expertId } = useParams(),
    navigate = useNavigate();
  const isNew = !expertId;
  const [modelId, setModelId] = useState("");
  const [detail, setDetail] = useState<ExpertDetail>(),
    [version, setVersion] = useState("");
  const [value, setValue] = useState<ExpertDefinition>(emptyExpert),
    [baseline, setBaseline] = useState<ExpertDefinition>(emptyExpert),
    [choices, setChoices] = useState<SkillChoice[]>([]);
  const [launch, setLaunch] = useState<{
    version: string;
    requestId: string;
    modelId?: string;
  }>();
  const createRequest = useRef<{
    version: string;
    requestId: string;
    modelId?: string;
  }>();
  const [packageDirty, setPackageDirty] = useState(false);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [installation, setInstallation] = useState<Installation | null>(null),
    [pollKey, setPollKey] = useState(0);
  const alive = useRef(true),
    allowLeave = useRef(false),
    saveRequest = useRef<{ body: string; id: string }>();
  const report = (error: unknown) => {
    if (!alive.current) return;
    problem(error);
    const labels: Record<string, string> = {
      EXPERT_VERSION_CONFLICT: "专家已在其他页面更新，请重新打开后核对。",
      EXPERT_NOT_READY: "请先安装这个专家版本。",
      SKILL_DISABLED: "绑定的技能已被删除或停用，请修改绑定后保存新版本。",
      INVALID_EXPERT: "请检查必填说明、最多3条示例和技能版本。",
      BUILD_ATTEMPT_CONFLICT: "安装状态已变化，正在刷新，请重新核对。",
      WORKBUDDY_CONNECTIONS_REQUIRED: "请先连接这个专家依赖的服务。",
      WORKBUDDY_CONNECTOR_UNAVAILABLE:
        "此包需要的WorkBuddy连接器尚未配置，请联系管理员接入对应服务。",
      WORKBUDDY_PRELOAD_MISSING: "包中引用的预加载技能缺失，请补齐所需技能。",
      EXPERT_DISABLED: "专家已被移除，不能开始新会话。",
    };
    setError(
      error instanceof ApiError
        ? (labels[error.code] ?? `操作未完成：${error.code}`)
        : error instanceof Error
          ? error.message
          : "操作失败，请重试",
    );
  };
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    setLoading(true);
    void (async () => {
      const items = await api.request<SkillChoice[]>(
        "/expert-skill-choices",
        "GET",
        undefined,
        abort.signal,
      );
      const item = expertId
        ? await api.request<ExpertDetail>(
            `/experts/${expertId}`,
            "GET",
            undefined,
            abort.signal,
          )
        : undefined;
      if (abort.signal.aborted) return;
      setChoices(items);
      setDetail(item);
      const initial = item?.versions.find(
        (row) => row.id === item.currentVersionId,
      );
      setVersion(initial?.id ?? "");
      setValue(initial?.definition ?? emptyExpert);
      setBaseline(initial?.definition ?? emptyExpert);
    })()
      .catch((error) => {
        if (!abort.signal.aborted) report(error);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [api, expertId]);
  useEffect(() => {
    if (!version) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setInstallation(null);
    const poll = async () => {
      try {
        const result = await api.request<Installation | null>(
          `/expert-versions/${version}/installation`,
          "GET",
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setInstallation(result);
        if (result && ["installing", "cancelling"].includes(result.state))
          timer = setTimeout(poll, 2000);
      } catch (error) {
        if (!abort.signal.aborted) report(error);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, version, pollKey]);
  const editable =
    isNew ||
    (detail?.source === "private" &&
      detail.status === "active" &&
      version === detail.currentVersionId);
  const dirty = editable && JSON.stringify(value) !== JSON.stringify(baseline);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowLeave.current &&
      (dirty || packageDirty) &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload(
    useCallback(
      (event) => {
        if (dirty) {
          event.preventDefault();
          event.returnValue = "";
        }
      },
      [dirty],
    ),
  );
  const action = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      report(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const save = () =>
    action(async () => {
      const body = JSON.stringify([expertId, version, value]);
      if (saveRequest.current?.body !== body)
        saveRequest.current = { body, id: crypto.randomUUID() };
      const item = await api.request<ExpertDetail>(
        expertId ? `/experts/${expertId}/versions` : "/experts",
        "POST",
        {
          clientRequestId: saveRequest.current.id,
          expectedVersionId: version || undefined,
          definition: value,
        },
      );
      if (!alive.current) return;
      setDetail(item);
      setVersion(item.currentVersionId);
      const saved = item.versions.find(
        (row) => row.id === item.currentVersionId,
      )!.definition;
      setValue(saved);
      setBaseline(saved);
      if (isNew) {
        allowLeave.current = true;
        navigate(`/experts/${item.id}`, { replace: true });
      }
    });
  const createSession = async (request: {
    version: string;
    requestId: string;
    modelId?: string;
  }) => {
    const session = await api.request<{ id: string }>("/sessions", "POST", {
      clientRequestId: request.requestId,
      title: `使用${value.name}`,
      template: "empty",
      expertVersionId: request.version,
      modelId: request.modelId || undefined,
    });
    if (alive.current) {
      createRequest.current = undefined;
      await created(session.id);
    }
  };
  useEffect(() => {
    if (
      !launch ||
      busy ||
      launch.version !== version ||
      installation?.state !== "ready"
    )
      return;
    const request = launch;
    setLaunch(undefined);
    void action(() => createSession(request));
  }, [launch, busy, version, installation?.state]);
  return (
    <Box flex={1} minH={0} overflowY="auto" bg="canvas" p={{ base: 4, lg: 7 }}>
      <Stack
        maxW="1050px"
        mx="auto"
        bg="surface"
        border="1px solid"
        borderColor="line"
        borderRadius="14px"
        p={{ base: 4, lg: 6 }}
        spacing={6}
      >
        <HStack flexWrap="wrap" gap={3}>
          <Heading size="md">{isNew ? "创建专家" : "专家详情"}</Heading>
          <Box flex={1} />
          <Button
            variant="ghost"
            isDisabled={busy}
            onClick={() => navigate("/experts")}
          >
            返回专家列表
          </Button>
        </HStack>
        {error && (
          <Alert status="error">
            <AlertIcon />
            {error}
          </Alert>
        )}
        {loading ? (
          <Spinner />
        ) : (
          <>
            {detail && (
              <HStack flexWrap="wrap">
                <Text color="muted">
                  {detail.source === "builtin"
                    ? "平台内置 · 只读，可复制后修改"
                    : version !== detail.currentVersionId
                      ? "历史版本 · 只读"
                      : "个人专家 · 保存即生成新版本"}
                </Text>
                <Box flex={1} />
                <Select
                  ariaLabel="专家版本"
                  width="200px"
                  value={version}
                  disabled={busy || dirty || packageDirty}
                  onChange={(selectedId) => {
                    const row = detail.versions.find(
                      (item) => item.id === selectedId,
                    )!;
                    setLaunch(undefined);
                    setVersion(row.id);
                    setValue(row.definition);
                    setBaseline(row.definition);
                  }}
                  options={detail.versions.map((item) => ({
                    value: item.id,
                    label: `v${item.versionNumber}${item.id === detail.currentVersionId ? " · 最新版本" : ""}`,
                  }))}
                />
              </HStack>
            )}
            {value.workbuddy ? (
              <>
                <Text fontWeight={600}>{value.name}</Text>
                <Text color="muted">{value.description}</Text>
                {value.workbuddy.warnings.map((warning, index) => (
                  <Text key={index} color="orange.700" fontSize="sm">
                    {warning}
                  </Text>
                ))}
                {value.workbuddy.expertType === "team" && (
                  <Alert status="warning">
                    <AlertIcon />
                    专家团使用主理人和成员 Agent
                    协作，所有成员共享这段会话的工作环境。
                  </Alert>
                )}
                {(Object.keys(value.workbuddy.mcpServers).length > 0 ||
                  value.workbuddy.connectors.length > 0) && (
                  <Alert status="warning">
                    <AlertIcon />
                    此包声明了外部依赖，请先完成下方连接。
                  </Alert>
                )}
                <ExpertConnections
                  key={`connections-${version}`}
                  version={version}
                />
                <WorkBuddyEditor
                  key={version}
                  version={version}
                  initialPath={(value.workbuddy.manifest.agents as string[])
                    .find((path) =>
                      path.endsWith(`/${value.workbuddy!.agentName}.md`),
                    )
                    ?.replace(/^\.\//, "")}
                  id={expertId!}
                  editable={!!editable}
                  dirtyChanged={setPackageDirty}
                  saved={(item) => {
                    setDetail(item);
                    setVersion(item.currentVersionId);
                    const next = item.versions.find(
                      (row) => row.id === item.currentVersionId,
                    )!.definition;
                    setValue(next);
                    setBaseline(next);
                  }}
                />
              </>
            ) : (
              <ExpertForm
                value={value}
                choices={choices}
                editable={!!editable}
                busy={busy}
                change={setValue}
              />
            )}
            <ModelPicker api={api} value={modelId} onChange={setModelId} />
            {installation && (
              <ExpertInstallation
                value={installation}
                choices={choices}
                busy={busy}
                cancel={() =>
                  void action(async () => {
                    setLaunch(undefined);
                    setInstallation(
                      await api.request<Installation>(
                        `/expert-installs/${installation.id}/cancel`,
                        "POST",
                        {},
                      ),
                    );
                    setPollKey((key) => key + 1);
                  })
                }
                retry={(requestId, expectedAttempt) =>
                  void action(async () => {
                    try {
                      setInstallation(
                        await api.request<Installation>(
                          `/expert-installs/${installation.id}/retry`,
                          "POST",
                          { requestId, expectedAttempt },
                        ),
                      );
                    } finally {
                      setPollKey((key) => key + 1);
                    }
                  })
                }
              />
            )}
            <Text fontSize="sm" color="muted">
              保存和安装不调用模型。开始对话后，发送第一条消息才启动执行环境；已有会话保持原专家和技能版本。
            </Text>
            <Flex gap={3} flexWrap="wrap">
              {editable && !value.workbuddy && (
                <Button
                  isDisabled={
                    busy ||
                    !dirty ||
                    !value.name ||
                    !value.description ||
                    !value.role ||
                    !value.workflow ||
                    !value.output
                  }
                  isLoading={busy}
                  onClick={() => void save()}
                >
                  {isNew ? "保存专家" : "保存为新版本"}
                </Button>
              )}
              {!isNew && detail?.status === "active" && (
                <>
                  <Button
                    colorScheme="green"
                    display={
                      value.workbuddy && !value.skillVersionIds.length
                        ? "none"
                        : undefined
                    }
                    isDisabled={
                      busy ||
                      dirty ||
                      installation?.state === "ready" ||
                      installation?.state === "installing" ||
                      installation?.state === "cancelling"
                    }
                    onClick={() =>
                      void action(async () => {
                        setInstallation(
                          await api.request<Installation>(
                            `/expert-versions/${version}/install`,
                            "POST",
                            {},
                          ),
                        );
                        setPollKey((key) => key + 1);
                      })
                    }
                  >
                    {installation?.state === "ready"
                      ? "此版本已安装"
                      : value.workbuddy
                        ? "准备技能"
                        : "安装此版本"}
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={
                      busy ||
                      dirty ||
                      packageDirty ||
                      !!launch ||
                      (!value.workbuddy && installation?.state !== "ready")
                    }
                    onClick={() =>
                      void action(async () => {
                        if (
                          createRequest.current?.version !== version ||
                          createRequest.current?.modelId !== modelId
                        )
                          createRequest.current = {
                            version,
                            modelId,
                            requestId: crypto.randomUUID(),
                          };
                        const request = createRequest.current;
                        if (
                          value.workbuddy &&
                          installation?.state !== "ready"
                        ) {
                          setLaunch(request);
                          try {
                            setInstallation(
                              await api.request<Installation>(
                                `/expert-versions/${version}/install`,
                                "POST",
                                {},
                              ),
                            );
                            setPollKey((key) => key + 1);
                          } catch (error) {
                            setLaunch(undefined);
                            throw error;
                          }
                        } else await createSession(request);
                      })
                    }
                  >
                    {value.workbuddy
                      ? launch
                        ? "准备完成后自动进入"
                        : "召唤专家"
                      : "开始对话"}
                  </Button>
                </>
              )}
              {detail?.source === "builtin" && (
                <Button
                  variant="outline"
                  isDisabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const item = await api.request<ExpertDetail>(
                        `/expert-versions/${version}/copy`,
                        "POST",
                        { clientRequestId: crypto.randomUUID() },
                      );
                      if (alive.current) navigate(`/experts/${item.id}`);
                    })
                  }
                >
                  复制到我的专家
                </Button>
              )}
              <Box flex={1} />
              {detail?.source === "private" && detail.status === "active" && (
                <Button
                  variant="ghost"
                  colorScheme="red"
                  isDisabled={busy}
                  onClick={() => {
                    if (confirm("移除这个专家？已有会话仍保留原版本。"))
                      void action(async () => {
                        await api.request(`/experts/${detail.id}`, "DELETE");
                        allowLeave.current = true;
                        navigate("/experts");
                      });
                  }}
                >
                  移除专家
                </Button>
              )}
            </Flex>
          </>
        )}
      </Stack>
      <Modal
        isOpen={blocker.state === "blocked"}
        onClose={() => {
          if (blocker.state === "blocked") blocker.reset();
        }}
      >
        <ModalOverlay />
        <ModalContent mx={4}>
          <ModalHeader>有未保存的修改</ModalHeader>
          <ModalBody>离开后，这次尚未保存的编辑将丢失。</ModalBody>
          <ModalFooter gap={3}>
            <Button
              variant="outline"
              onClick={() => {
                if (blocker.state === "blocked") blocker.reset();
              }}
            >
              继续编辑
            </Button>
            <Button
              colorScheme="red"
              isDisabled={busy}
              onClick={() => {
                if (blocker.state === "blocked") blocker.proceed();
              }}
            >
              放弃修改并离开
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
}
