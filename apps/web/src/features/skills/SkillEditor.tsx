import { ModelPicker } from "../llm/ModelPicker.js";
/** 编辑缓存在浏览器内；一次保存提交全部文件，服务端生成一个不可变版本。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  HStack,
  Input,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Select } from "../../shared/select.js";
import { useBeforeUnload, useBlocker } from "react-router";
import { SkillFiles } from "./SkillFiles.js";
import { PreparationPanel } from "./PreparationPanel.js";
import { skillError } from "./errors.js";
import type { Detail, FileItem, Preparation } from "./types.js";
import type { BrowserApi } from "../../state/api.js";
export function SkillEditor({
  api,
  id,
  close,
  changed,
  created,
  problem,
}: {
  api: BrowserApi;
  id: string;
  close(): void;
  changed(): Promise<void>;
  created(id: string): void;
  problem(error: unknown): void;
}) {
  const [detail, setDetail] = useState<Detail>(),
    [version, setVersion] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]),
    [baseline, setBaseline] = useState<FileItem[]>([]);
  const [path, setPath] = useState("SKILL.md"),
    [name, setName] = useState("");
  const [modelId,setModelId]=useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [preparation, setPreparation] = useState<Preparation>(),
    [pollKey, setPollKey] = useState(0);
  const allowLeave = useRef(false);
  const alive = useRef(true),
    loadGeneration = useRef(0);
  const report = (error: unknown) => {
    if (alive.current) {
      problem(error);
      setError(skillError(error));
    }
  };
  const load = async (requested?: string) => {
    const current = ++loadGeneration.current;
    setLoading(true);
    try {
      const item = await api.request<Detail>(`/skills/${id}`),
        next = requested ?? item.currentVersionId!;
      const contents = await api.request<FileItem[]>(
        `/skill-versions/${next}/files`,
      );
      if (!alive.current || current !== loadGeneration.current) return;
      setDetail(item);
      setVersion(next);
      setFiles(contents);
      setBaseline(contents);
      setName(item.displayName);
      setPath("SKILL.md");
    } finally {
      if (alive.current && current === loadGeneration.current)
        setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load().catch(report);
    return () => {
      alive.current = false;
      loadGeneration.current++;
    };
  }, [id, api]);
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
  const requestId = detail?.setting?.pendingRequestId;
  useEffect(() => {
    if (!requestId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.request<Preparation>(
          `/skill-build-requests/${requestId}`,
          "GET",
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setPreparation(result);
        if (result.request.state === "waiting") timer = setTimeout(poll, 2000);
        else {
          const updated = await api.request<Detail>(
            `/skills/${id}`,
            "GET",
            undefined,
            abort.signal,
          );
          if (!abort.signal.aborted) {
            setDetail(updated);
            await changed();
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) report(error);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [requestId, pollKey]);
  const editable =
    detail?.source === "private" && version === detail.currentVersionId;
  const dirty =
    !!editable &&
    (JSON.stringify(files) !== JSON.stringify(baseline) ||
      name !== detail?.displayName);
  const installed =
    !!detail?.setting?.enabled && detail.setting.activeVersionId === version;
  const installing = preparation?.request.state === "waiting";
  // 路由切换和浏览器后退共用同一处未保存提醒，避免链接绕过编辑保护。
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowLeave.current &&
      dirty &&
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
  const leave = () => {
    if (!busy) close();
  };
  const save = () =>
    action(async () => {
      const changes: { path: string; text?: string; remove?: boolean }[] = files
        .filter(
          (file) =>
            file.text !== undefined &&
            !baseline.some(
              (old) => old.path === file.path && old.text === file.text,
            ),
        )
        .map((file) => ({ path: file.path, text: file.text }));
      for (const old of baseline)
        if (!files.some((file) => file.path === old.path))
          changes.push({ path: old.path, remove: true });
      await api.request(`/skills/${id}/versions`, "POST", {
        expectedVersionId: version,
        clientRequestId: crypto.randomUUID(),
        changes,
        displayName: name,
      });
      await load();
      await changed();
    });
  const install = () =>
    action(async () => {
      const updated = await api.request<Detail>(`/me/skills/${id}`, "PATCH", {
        enabled: true,
        versionId: version,
        expectedRevision: detail?.setting?.revision ?? 0,
        clientRequestId: crypto.randomUUID(),
      });
      if (alive.current) {
        setDetail(updated);
        setPollKey((key) => key + 1);
      }
      await changed();
    });
  return (
    <>
      <Box
        flex={1}
        minH={0}
        overflowY="auto"
        bg="canvas"
        p={{ base: 4, lg: 7 }}
      >
        <Box
          bg="surface"
          border="1px solid"
          borderColor="line"
          borderRadius="14px"
          p={{ base: 4, lg: 6 }}
        >
          <HStack justify="space-between" mb={5}>
            <Text fontSize="20px" fontWeight={600}>
              技能详情
            </Text>
            <Button variant="ghost" onClick={leave} isDisabled={busy}>
              返回技能列表
            </Button>
          </HStack>
          {error && (
            <Alert status="error" mb={4}>
              <AlertIcon />
              {error}
            </Alert>
          )}
          {loading ? (
            <Spinner />
          ) : (
            detail && (
              <Stack spacing={5}>
                <ModelPicker api={api} value={modelId} onChange={setModelId} />
                <HStack flexWrap="wrap" gap={3}>
                  <Input
                    aria-label="技能名称"
                    flex={1}
                    minW="180px"
                    value={name}
                    isReadOnly={!editable}
                    isDisabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Select
                    ariaLabel="技能版本"
                    width="180px"
                    value={version}
                    disabled={busy || dirty}
                    onChange={(selectedId) =>
                      void load(selectedId).catch(report)
                    }
                    options={detail.versions.map((item) => ({
                      value: item.id,
                      label: `v${item.versionNumber}${item.id === detail.currentVersionId ? " · 最新版本" : ""}`,
                    }))}
                  />
                </HStack>
                <Text fontSize="sm" color="muted">
                  {dirty
                    ? "有未保存的修改。切换文件不会丢失内容，保存后一起生成新版本。"
                    : editable
                      ? "直接编辑并保存为新版本。安装后用于新会话，已有会话保持原版本。"
                      : "此版本只读，可以导出查看。"}
                </Text>
                {preparation && (
                  <PreparationPanel
                    value={preparation}
                    busy={busy}
                    cancel={() =>
                      void action(async () => {
                        const result = await api.request<Preparation>(
                          `/skill-build-requests/${requestId}/cancel`,
                          "POST",
                          {},
                        );
                        if (alive.current) {
                          setPreparation(result);
                          setPollKey((key) => key + 1);
                        }
                        await changed();
                      })
                    }
                    retry={() =>
                      void action(async () => {
                        const result = await api.request<Preparation>(
                          `/skill-build-requests/${requestId}/retry`,
                          "POST",
                          { expectedAttempt: preparation.build.attempt },
                        );
                        if (alive.current) {
                          setPreparation(result);
                          setPollKey((key) => key + 1);
                        }
                        await changed();
                      })
                    }
                  />
                )}
                <SkillFiles
                  files={files}
                  path={path}
                  text={files.find((file) => file.path === path)?.text ?? ""}
                  editable={!!editable}
                  busy={busy}
                  select={(path) => setPath(path)}
                  change={(text) =>
                    setFiles(
                      files.map((file) =>
                        file.path === path ? { ...file, text } : file,
                      ),
                    )
                  }
                  add={(newPath) => {
                    if (files.some((file) => file.path === newPath)) {
                      setError("文件路径已存在");
                      return;
                    }
                    setFiles([...files, { path: newPath, text: "", size: 0 }]);
                    setPath(newPath);
                  }}
                  remove={(path) => {
                    setFiles(files.filter((file) => file.path !== path));
                    setPath("SKILL.md");
                  }}
                />
                <HStack flexWrap="wrap" gap={2}>
                  <Button
                    variant="ghost"
                    isDisabled={busy || dirty}
                    onClick={() =>
                      void action(async () => {
                        const blob = await api.exportSkill(version),
                          url = URL.createObjectURL(blob),
                          link = document.createElement("a");
                        link.href = url;
                        link.download = `${detail.slug}-v${detail.versions.find((item) => item.id === version)?.versionNumber}.zip`;
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      })
                    }
                  >
                    导出此版本
                  </Button>
                  {detail.source === "builtin" && (
                    <Button
                      variant="ghost"
                      isDisabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api.request(
                            `/skill-versions/${version}/copy`,
                            "POST",
                            {
                              clientRequestId: crypto.randomUUID(),
                              displayName: detail.displayName,
                            },
                          );
                          await changed();
                          close();
                        })
                      }
                    >
                      复制到我的技能
                    </Button>
                  )}
                  {!!detail.setting?.enabled && (
                    <Button
                      variant="ghost"
                      isDisabled={busy || dirty}
                      onClick={() =>
                        void action(async () => {
                          const session = await api.create(
                            `使用${detail.displayName}`,
                            "empty",
                            [detail.setting!.activeVersionId!],
                            modelId,
                          );
                          created(session.id);
                        })
                      }
                    >
                      开始对话
                    </Button>
                  )}
                  <Box flex={1} />
                  {detail.source === "private" && (
                    <Button
                      colorScheme="red"
                      variant="ghost"
                      isDisabled={busy}
                      onClick={() => {
                        if (confirm("移除这个技能？已有会话仍保留固定版本。"))
                          void action(async () => {
                            await api.request(`/skills/${id}`, "DELETE");
                            await changed();
                            allowLeave.current = true;
                            close();
                          });
                      }}
                    >
                      移除技能
                    </Button>
                  )}
                </HStack>
              </Stack>
            )
          )}

          <HStack mt={5} gap={3} flexWrap="wrap" justify="flex-end">
            {editable && (
              <Button
                variant="outline"
                isLoading={busy}
                isDisabled={!dirty || loading}
                onClick={() => void save()}
              >
                保存为新版本
              </Button>
            )}
            <Button
              colorScheme="green"
              isDisabled={
                !detail || busy || dirty || loading || installing || installed
              }
              onClick={() => void install()}
            >
              {installing
                ? "正在安装…"
                : installed
                  ? "已启用此版本"
                  : detail?.setting?.enabled
                    ? "安装更新并启用"
                    : "安装并启用"}
            </Button>
          </HStack>
        </Box>
      </Box>
      <Modal
        isOpen={blocker.state === "blocked"}
        onClose={() => {
          if (blocker.state === "blocked") blocker.reset();
        }}
      >
        <ModalOverlay />
        <ModalContent mx={4}>
          <ModalHeader>有未保存的修改</ModalHeader>
          <ModalBody>
            <Text>离开后，这次尚未保存的编辑将丢失。</Text>
          </ModalBody>
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
    </>
  );
}
