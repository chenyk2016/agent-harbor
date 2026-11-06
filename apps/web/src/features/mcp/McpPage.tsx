/** MCP 连接：远程、本地模板与私有脚本共用一套编辑表单。 */
import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Input,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Plus, Terminal } from "lucide-react";
import { Select } from "../../shared/select.js";
import { useWorkbench } from "../../app/workbench-context.js";
import { PageHeader } from "../shell/PageHeader.js";

interface Connection {
  id: string;
  name: string;
  kind: "remote" | "local" | "script";
  url?: string;
  templateId?: string;
  scriptId?: string;
  scriptScope?: "admin" | "user";
  enabled: boolean;
  revision: number;
  credentialsConfigured: boolean;
  migrationPending?: boolean;
}
interface Template {
  id: string;
  name: string;
  secretKeys: string[];
}
interface Script {
  id: string;
  name: string;
  scope: "admin" | "user";
  runtime: "node" | "python";
  entry: string;
  secretKeys: string[];
  files?: Record<string, string>;
  install?: string;
}

const kindLabel = (kind: Connection["kind"]) =>
  kind === "remote" ? "远程" : kind === "local" ? "本地模板" : "手写脚本";

export function McpPage() {
  const { api, problem } = useWorkbench();
  const [rows, setRows] = useState<Connection[]>([]),
    [templates, setTemplates] = useState<Template[]>([]),
    [scripts, setScripts] = useState<Script[]>([]);
  const [current, setCurrent] = useState<Connection>(),
    [name, setName] = useState(""),
    [kind, setKind] = useState<Connection["kind"]>("remote"),
    [url, setUrl] = useState(""),
    [templateId, setTemplate] = useState(""),
    [scriptKey, setScriptKey] = useState("");
  const [credentials, setCredentials] = useState(""),
    [enabled, setEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [tools, setTools] = useState<string[]>([]);
  const [scriptEdit, setScriptEdit] = useState(false),
    [scriptId, setScriptId] = useState<string>(),
    [scriptName, setScriptName] = useState(""),
    [runtime, setRuntime] = useState("node"),
    [entry, setEntry] = useState("server.mjs"),
    [install, setInstall] = useState("none"),
    [fields, setFields] = useState(""),
    [files, setFiles] = useState('{"server.mjs":"// Your MCP server code"}');
  const load = async () => {
    const [a, b, c] = await Promise.all([
      api.request<Connection[]>("/mcp-connections"),
      api.request<Template[]>("/mcp-templates"),
      api.request<Script[]>("/mcp-scripts"),
    ]);
    setRows(a);
    setTemplates(b);
    setScripts(c);
  };
  useEffect(() => {
    void load().catch(problem);
    return () => setCredentials("");
  }, [api]);
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      problem(e);
    } finally {
      setBusy(false);
    }
  };
  const edit = (c?: Connection) => {
    setCurrent(c);
    setName(c?.name ?? "");
    setKind(c?.kind ?? "remote");
    setUrl(c?.url ?? "");
    setTemplate(c?.templateId ?? "");
    setScriptKey(c?.scriptId ? c.scriptScope + ":" + c.scriptId : "");
    setCredentials("");
    setEnabled(c?.enabled ?? true);
    setNotice("");
    setTools([]);
  };
  const save = () =>
    work(async () => {
      const [scriptScope, scriptId] = scriptKey.split(":");
      const saved = await api.request<Connection>(
        "/mcp-connections" + (current ? "/" + current.id : ""),
        current ? "PUT" : "POST",
        {
          name,
          kind,
          url,
          templateId,
          scriptScope,
          scriptId,
          enabled,
          ...(current?.migrationPending ? { confirmAllTools: true } : {}),
          ...(current ? { expectedRevision: current.revision } : {}),
          ...(credentials.trim()
            ? { credentials: JSON.parse(credentials) }
            : {}),
        },
      );
      setCurrent(saved);
      setCredentials("");
      await load();
      setNotice(
        "已保存。当前任务不受影响，下次发送前重新加载；也可在空闲会话关闭环境。启用连接允许使用其全部工具。",
      );
    });
  const editScript = (id?: string) =>
    work(async () => {
      if (id) {
        const s = await api.request<Script>("/mcp-scripts/" + id);
        setScriptId(id);
        setScriptName(s.name);
        setRuntime(s.runtime);
        setEntry(s.entry);
        setInstall(s.install ?? "none");
        setFields(s.secretKeys.join(","));
        setFiles(JSON.stringify(s.files, null, 2));
      } else {
        setScriptId(undefined);
        setScriptName("");
        setRuntime("node");
        setEntry("server.mjs");
        setInstall("none");
        setFields("");
        setFiles('{"server.mjs":"// Your MCP server code"}');
      }
      setScriptEdit(true);
    });

  const summary = (c: Connection) =>
    c.kind === "remote"
      ? c.url
      : c.kind === "local"
        ? (templates.find((t) => t.id === c.templateId)?.name ?? "模板暂不可用")
        : (scripts.find(
            (s) => s.id === c.scriptId && s.scope === c.scriptScope,
          )?.name ?? "脚本暂不可用");

  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box maxW="1120px" mx="auto" px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }}>
        <PageHeader
          title="MCP 连接"
          subtitle="远程服务直接连接；本地工具与私有脚本在会话沙箱中运行。启用后允许使用服务提供的全部工具。"
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Terminal size={14} />}
                onClick={() => void editScript()}
              >
                新建私有脚本
              </Button>
              <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => edit()}>
                新建连接
              </Button>
            </>
          }
        />

        <Flex direction={{ base: "column", lg: "row" }} gap={4} align="start">
          <Box w={{ base: "full", lg: "300px" }} flexShrink={0}>
            <Text fontSize="10.5px" fontWeight={600} color="muted" mb={2}>
              连接
            </Text>
            <Flex direction="column" gap={1.5}>
              {rows.map((c) => {
                const active = current?.id === c.id;
                return (
                  <Box
                    as="button"
                    type="button"
                    key={c.id}
                    textAlign="left"
                    p="10px 11px"
                    border="1px solid"
                    borderColor={active ? "brand.500" : "line"}
                    bg={active ? "brand.50" : "surface"}
                    borderRadius="9px"
                    _hover={{ borderColor: active ? "brand.500" : "lineStrong" }}
                    _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
                    onClick={() => edit(c)}
                  >
                    <Flex align="center" gap={1.5} flexWrap="wrap">
                      <Text
                        fontSize="12.5px"
                        fontWeight={600}
                        noOfLines={1}
                        maxW="160px"
                      >
                        {c.name}
                      </Text>
                      <Badge>{kindLabel(c.kind)}</Badge>
                    </Flex>
                    <Text
                      fontFamily="mono"
                      fontSize="10px"
                      color="muted"
                      mt="3px"
                      noOfLines={1}
                    >
                      {summary(c)}
                    </Text>
                    <HStack spacing={1.5} mt={1.5}>
                      <Badge
                        bg={c.enabled ? "okTint" : "sunken"}
                        color={c.enabled ? "ok" : "muted"}
                      >
                        {c.enabled ? "已启用" : "已停用"}
                      </Badge>
                      {c.migrationPending && (
                        <Badge bg="warnTint" color="warnStrong">
                          需重新确认
                        </Badge>
                      )}
                    </HStack>
                  </Box>
                );
              })}
              {!rows.length && (
                <Text fontSize="12px" color="muted">
                  还没有连接。
                </Text>
              )}
            </Flex>

            {scripts.filter((s) => s.scope === "user").length > 0 && (
              <Box mt={4}>
                <Text fontSize="10.5px" fontWeight={600} color="muted" mb={2}>
                  我的脚本
                </Text>
                <Flex direction="column" gap={1}>
                  {scripts
                    .filter((s) => s.scope === "user")
                    .map((s) => (
                      <Button
                        key={s.id}
                        variant="ghost"
                        size="sm"
                        justifyContent="flex-start"
                        fontWeight={400}
                        onClick={() => void editScript(s.id)}
                      >
                        {s.name}
                      </Button>
                    ))}
                </Flex>
              </Box>
            )}
          </Box>

          <Box
            flex={1}
            minW={0}
            border="1px solid"
            borderColor="line"
            borderRadius="14px"
            bg="surface"
            p={5}
          >
            <Text fontSize="14px" fontWeight={650}>
              {current ? "编辑连接" : "新建连接"}
            </Text>
            <Text fontSize="11.5px" color="muted" mt="3px" mb={4} lineHeight={1.6}>
              配置与密钥修改在重新加载环境后生效；当前任务不受影响。
            </Text>

            {current?.migrationPending && (
              <Alert status="warning" borderRadius="8px" mb={3} fontSize="12px">
                <AlertIcon boxSize="14px" />
                旧版连接已停用。请检查并保存，确认后将按整个服务启用。
              </Alert>
            )}

            <Stack spacing={3}>
              <FormControl>
                <FormLabel>连接名称</FormLabel>
                <Input
                  aria-label="连接名称"
                  placeholder="例如：GitHub API"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </FormControl>
              <FormControl>
                <FormLabel>连接类型</FormLabel>
                <Select
                  ariaLabel="连接类型"
                  value={kind}
                  onChange={(v) => setKind(v as Connection["kind"])}
                  options={[
                    { value: "remote", label: "远程 MCP（HTTP）" },
                    { value: "local", label: "管理员本地模板" },
                    { value: "script", label: "手写 MCP 脚本" },
                  ]}
                />
              </FormControl>
              {kind === "remote" ? (
                <FormControl>
                  <FormLabel>服务地址</FormLabel>
                  <Input
                    aria-label="MCP URL"
                    placeholder="https://example.com/mcp"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </FormControl>
              ) : kind === "local" ? (
                <FormControl>
                  <FormLabel>本地模板</FormLabel>
                  <Select
                    ariaLabel="本地模板"
                    value={templateId}
                    placeholder="选择管理员提供的 MCP"
                    onChange={setTemplate}
                    options={templates.map((t) => ({
                      value: t.id,
                      label: t.name,
                    }))}
                  />
                  <Text fontSize="11px" color="muted" mt={1.5}>
                    参数字段：
                    {templates
                      .find((t) => t.id === templateId)
                      ?.secretKeys.join(", ") || "无需凭据"}
                  </Text>
                </FormControl>
              ) : (
                <FormControl>
                  <FormLabel>脚本</FormLabel>
                  <Select
                    ariaLabel="MCP脚本"
                    value={scriptKey}
                    placeholder="选择脚本"
                    onChange={setScriptKey}
                    options={scripts.map((s) => ({
                      value: s.scope + ":" + s.id,
                      label:
                        (s.scope === "admin" ? "管理员：" : "我的：") + s.name,
                    }))}
                  />
                  <Text fontSize="11px" color="muted" mt={1.5}>
                    脚本原件保留；每个会话使用自己的运行副本。
                  </Text>
                </FormControl>
              )}
              <FormControl>
                <FormLabel>凭据 JSON</FormLabel>
                <Textarea
                  aria-label="凭据 JSON"
                  autoComplete="off"
                  spellCheck={false}
                  fontFamily="mono"
                  fontSize="12px"
                  minH="96px"
                  placeholder={
                    kind === "remote"
                      ? '请求头 JSON，例如 {"Authorization":"Bearer …"}'
                      : "参数 JSON，仅允许模板或脚本声明的字段"
                  }
                  value={credentials}
                  onChange={(e) => setCredentials(e.target.value)}
                />
                <Text fontSize="10.5px" color="muted" mt={1.5}>
                  留空保留已存参数；填写 {"{}"} 清空。凭据不回显。
                  {current?.credentialsConfigured ? " 当前已保存凭据。" : ""}
                </Text>
              </FormControl>
              <Checkbox
                isChecked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                size="sm"
              >
                启用此连接
              </Checkbox>
              <Flex gap={2} flexWrap="wrap">
                <Button size="sm" isLoading={busy} onClick={() => void save()}>
                  保存
                </Button>
                {current && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={busy}
                      onClick={() =>
                        void work(async () => {
                          const r = await api.request<{
                            tools: { name: string }[];
                          }>("/mcp-connections/" + current.id + "/test", "POST");
                          setTools(r.tools.map((t) => t.name));
                          setNotice("连接测试成功；未调用模型，也未执行业务工具。");
                        })
                      }
                    >
                      测试连接
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      color="dangerStrong"
                      isDisabled={busy}
                      onClick={() =>
                        void work(async () => {
                          await api.request(
                            "/mcp-connections/" + current.id,
                            "DELETE",
                          );
                          edit();
                          await load();
                        })
                      }
                    >
                      删除连接
                    </Button>
                  </>
                )}
              </Flex>
              {tools.length > 0 && (
                <Text fontSize="11.5px" color="ink2">
                  可用工具：{tools.join("、")}
                </Text>
              )}
              {notice && (
                <Text fontSize="11.5px" role="status" color="ink2">
                  {notice}
                </Text>
              )}
            </Stack>
          </Box>
        </Flex>

        {scriptEdit && (
          <Box
            mt={4}
            border="1px solid"
            borderColor="line"
            borderRadius="14px"
            bg="surface"
            p={5}
          >
            <Text fontSize="14px" fontWeight={650} mb={4}>
              {scriptId ? "编辑私有脚本" : "新建私有脚本"}
            </Text>
            <Stack spacing={3}>
              <FormControl>
                <FormLabel>脚本名称</FormLabel>
                <Input
                  aria-label="脚本名称"
                  placeholder="例如：本地文件工具"
                  value={scriptName}
                  onChange={(e) => setScriptName(e.target.value)}
                />
              </FormControl>
              <Flex gap={3} flexWrap="wrap">
                <FormControl flex="1 1 180px">
                  <FormLabel>运行时</FormLabel>
                  <Select
                    ariaLabel="脚本运行时"
                    value={runtime}
                    onChange={setRuntime}
                    options={[
                      { value: "node", label: "Node.js" },
                      { value: "python", label: "Python" },
                    ]}
                  />
                </FormControl>
                <FormControl flex="1 1 180px">
                  <FormLabel>入口文件</FormLabel>
                  <Input
                    aria-label="脚本入口"
                    placeholder="server.mjs 或 server.py"
                    value={entry}
                    onChange={(e) => setEntry(e.target.value)}
                  />
                </FormControl>
              </Flex>
              <FormControl>
                <FormLabel>依赖准备</FormLabel>
                <Select
                  ariaLabel="脚本依赖准备"
                  value={install}
                  onChange={setInstall}
                  options={[
                    { value: "none", label: "无需额外依赖" },
                    { value: "npm", label: "npm ci（需要 package-lock.json）" },
                    { value: "uv", label: "uv（需要 requirements.txt）" },
                  ]}
                />
              </FormControl>
              <FormControl>
                <FormLabel>允许的环境参数</FormLabel>
                <Input
                  aria-label="脚本参数字段"
                  placeholder="如 API_KEY，多个字段用逗号分隔"
                  value={fields}
                  onChange={(e) => setFields(e.target.value)}
                />
              </FormControl>
              <FormControl>
                <FormLabel>文件 JSON</FormLabel>
                <Textarea
                  aria-label="脚本文件 JSON"
                  fontFamily="mono"
                  fontSize="12px"
                  minH="220px"
                  value={files}
                  onChange={(e) => setFiles(e.target.value)}
                />
                <Text fontSize="10.5px" color="muted" mt={1.5}>
                  文件名对应源码字符串。只允许相对路径；请勿把密钥写入源码。
                </Text>
              </FormControl>
              <HStack>
                <Button
                  size="sm"
                  isLoading={busy}
                  onClick={() =>
                    void work(async () => {
                      await api.request(
                        "/mcp-scripts" + (scriptId ? "/" + scriptId : ""),
                        scriptId ? "PUT" : "POST",
                        {
                          name: scriptName,
                          runtime,
                          entry,
                          install,
                          secretKeys: fields
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                          files: JSON.parse(files),
                        },
                      );
                      setScriptEdit(false);
                      await load();
                      setNotice("脚本已保存。重新加载会话环境后使用新内容。");
                    })
                  }
                >
                  保存脚本
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setScriptEdit(false)}>
                  取消编辑
                </Button>
              </HStack>
            </Stack>
          </Box>
        )}
      </Box>
    </Box>
  );
}
