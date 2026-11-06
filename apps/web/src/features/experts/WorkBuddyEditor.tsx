/** 编辑包内原文件；未编辑文件和未知字段始终保留，保存形成新修订。 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Button,
  HStack,
  Input,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Select } from "../../shared/select.js";
import { useNavigate, useBlocker, useBeforeUnload } from "react-router";
import { useWorkbench } from "../../app/workbench-context.js";
import type { ExpertDetail } from "./types.js";
interface PackageFile {
  path: string;
  size: number;
  text?: string;
}
export function WorkBuddyEditor({
  version,
  id,
  editable,
  saved,
  dirtyChanged,
  initialPath,
}: {
  initialPath?: string;
  version: string;
  id: string;
  editable: boolean;
  saved: (item: ExpertDetail) => void;
  dirtyChanged: (value: boolean) => void;
}) {
  const { api } = useWorkbench();
  const [files, setFiles] = useState<PackageFile[]>([]),
    [selected, setSelected] = useState(""),
    [changes, setChanges] = useState<Record<string, string | null>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [newPath, setNewPath] = useState("");
  const alive = useRef(true),
    request = useRef<{ body: string; id: string }>();
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => {
    alive.current = true;
    const abort = new AbortController();
    setFiles([]);
    setChanges({});
    void api
      .request<PackageFile[]>(
        `/expert-versions/${version}/files`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((items) => {
        if (!abort.signal.aborted) {
          setFiles(items);
          setSelected(
            items.find((file) => file.path === initialPath)?.path ??
              items.find(
                (file) =>
                  file.path.startsWith("agents/") && file.path.endsWith(".md"),
              )?.path ??
              items[0]?.path ??
              "",
          );
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });
    return () => {
      alive.current = false;
      abort.abort();
    };
  }, [api, version, initialPath]);
  useEffect(() => {
    dirtyChanged(dirty);
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty, dirtyChanged]);
  const current = files.find((file) => file.path === selected),
    text = Object.hasOwn(changes, selected) ? changes[selected] : current?.text;
  async function save() {
    setBusy(true);
    setError("");
    const payload = {
      expectedVersionId: version,
      changes: Object.entries(changes).map(([path, text]) => ({ path, text })),
    };
    const body = JSON.stringify(payload);
    if (request.current?.body !== body)
      request.current = { body, id: crypto.randomUUID() };
    try {
      const item = await api.request<ExpertDetail>(
        `/experts/${id}/package-versions`,
        "POST",
        { ...payload, clientRequestId: request.current.id },
      );
      if (alive.current) {
        setChanges({});
        saved(item);
      }
    } catch (error) {
      if (alive.current) setError(String(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const paths = [
    ...new Set([...files.map((file) => file.path), ...Object.keys(changes)]),
  ];
  return (
    <Stack spacing={4}>
      <Text color="muted">
        WorkBuddy 原生包 · 编辑完整文件，保存生成新版本。未修改的资源保持原样。
      </Text>
      {error && (
        <Alert status="error">
          <AlertIcon />
          {error}
        </Alert>
      )}
      <HStack>
        <Select
          ariaLabel="专家包文件"
          value={selected}
          onChange={(next) => setSelected(next)}
          options={paths.map((path) => ({
            value: path,
            label: `${path}${Object.hasOwn(changes, path) ? " · 已修改" : ""}`,
          }))}
        />
        <Button
          as="a"
          href={`/api/expert-versions/${version}/export`}
          variant="outline"
        >
          下载原包
        </Button>
      </HStack>
      {text === undefined ? (
        <Text color="muted">
          二进制资源（{current?.size ?? 0} 字节），随包保留。
        </Text>
      ) : text === null ? (
        <Text>保存时将删除此文件。</Text>
      ) : (
        <Textarea
          aria-label="专家包文件内容"
          value={text}
          isReadOnly={!editable || busy}
          minH="400px"
          fontFamily="mono"
          fontSize="14px"
          onChange={(event) => {
            const value = event.target.value;
            setChanges((old) => {
              const next = { ...old };
              if (value === current?.text) delete next[selected];
              else next[selected] = value;
              return next;
            });
          }}
        />
      )}
      {editable && (
        <>
          <HStack>
            <Input
              aria-label="新文件路径"
              placeholder="新文件路径，例如 agents/helper.md"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
            />
            <Button
              variant="outline"
              isDisabled={!newPath || paths.includes(newPath) || busy}
              onClick={() => {
                setChanges((old) => ({ ...old, [newPath]: "" }));
                setSelected(newPath);
                setNewPath("");
              }}
            >
              添加文件
            </Button>
          </HStack>
          <HStack>
            <Button
              isLoading={busy}
              isDisabled={!dirty}
              onClick={() => void save()}
            >
              保存包新版本
            </Button>
            <Button
              variant="ghost"
              isDisabled={!dirty || busy}
              onClick={() => setChanges({})}
            >
              放弃修改
            </Button>
            <Button
              variant="ghost"
              colorScheme="red"
              isDisabled={!selected || busy}
              onClick={() =>
                setChanges((old) => ({ ...old, [selected]: null }))
              }
            >
              删除此文件
            </Button>
          </HStack>
        </>
      )}
    </Stack>
  );
}
export function NewWorkBuddyExpert() {
  const { api } = useWorkbench(),
    navigate = useNavigate();
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [instructions, setInstructions] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef<{ body: string; id: string }>();
  const allowLeave = useRef(false),
    alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const dirty = !!(name || description || instructions);
  const blocker = useBlocker(dirty && !allowLeave.current);
  useBeforeUnload((event) => {
    if (dirty && !allowLeave.current) event.preventDefault();
  });
  const create = async () => {
    setBusy(true);
    const payload = { name, description, instructions },
      body = JSON.stringify(payload);
    if (request.current?.body !== body)
      request.current = { body, id: crypto.randomUUID() };
    try {
      const item = await api.request<ExpertDetail>("/expert-packages", "POST", {
        ...payload,
        clientRequestId: request.current.id,
      });
      if (alive.current) {
        allowLeave.current = true;
        navigate(`/experts/${item.id}`, { replace: true });
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack flex={1} overflowY="auto" p={{ base: 5, lg: 8 }} spacing={5}>
      <Text fontSize="xl" fontWeight={600}>
        创建 WorkBuddy 格式专家
      </Text>
      <Text color="muted">
        保存生成 plugin.json 和完整 Agent
        Markdown，也可以返回列表直接导入已有专家包。
      </Text>
      {blocker.state === "blocked" && (
        <Alert status="warning">
          <Stack>
            <Text>有未保存的专家说明。</Text>
            <HStack>
              <Button onClick={() => blocker.reset()}>继续编辑</Button>
              <Button onClick={() => blocker.proceed()}>放弃修改并离开</Button>
            </HStack>
          </Stack>
        </Alert>
      )}
      {error && (
        <Alert status="error">
          <AlertIcon />
          {error}
        </Alert>
      )}
      <Input
        aria-label="专家名称"
        placeholder="专家名称"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        aria-label="专家简介"
        placeholder="简介"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <Textarea
        aria-label="完整专家说明"
        placeholder="使用 Markdown 编写完整角色、方法、案例和输出要求……"
        minH="400px"
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
      />
      <HStack>
        <Button
          isLoading={busy}
          isDisabled={!name || !instructions}
          onClick={() => void create()}
        >
          保存专家
        </Button>
        <Button variant="ghost" onClick={() => navigate("/experts")}>
          返回列表
        </Button>
      </HStack>
    </Stack>
  );
}
