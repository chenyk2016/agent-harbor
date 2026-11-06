/** 凭据只提交到用户连接接口，不写进专家包或浏览器持久化。 */
import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  HStack,
  Input,
  Stack,
  Text,
} from "@chakra-ui/react";
import { useWorkbench } from "../../app/workbench-context.js";
interface Connection {
  name: string;
  displayName: string;
  description: string;
  ready: boolean;
  auth: {
    type?: string;
    tokenSchema?: {
      fields?: {
        key: string;
        label?: string | { zh?: string; en?: string };
        type?: string;
        required?: boolean;
      }[];
    };
  };
}
const label = (
  value: string | { zh?: string; en?: string } | undefined,
  fallback: string,
) => (typeof value === "string" ? value : (value?.zh ?? value?.en ?? fallback));
export function ExpertConnections({ version }: { version: string }) {
  const { api } = useWorkbench();
  const [network, setNetwork] = useState(""),
    [networkBusy, setNetworkBusy] = useState(false);
  const [items, setItems] = useState<Connection[]>([]),
    [unavailable, setUnavailable] = useState<string[]>([]),
    [values, setValues] = useState<Record<string, Record<string, string>>>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [refresh, setRefresh] = useState(0),
    [authorization, setAuthorization] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void api
      .request<{ items: Connection[]; unavailableConnectors: string[] }>(
        `/expert-versions/${version}/connections`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((result) => {
        if (!abort.signal.aborted) {
          setItems(result.items);
          setUnavailable(result.unavailableConnectors);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });
    void api
      .request<{ domains: string[] }>(
        `/expert-versions/${version}/network`,
        "GET",
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setNetwork(value.domains.join("\n"));
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });
    const update = () => setRefresh((value) => value + 1);
    window.addEventListener("focus", update);
    return () => {
      abort.abort();
      window.removeEventListener("focus", update);
    };
  }, [api, version, refresh]);
  async function change(item: Connection) {
    setBusy(item.name);
    setError("");
    setAuthorization("");
    try {
      if (item.ready)
        await api.request(
          `/expert-versions/${version}/connections/${item.name}`,
          "DELETE",
        );
      else {
        const result = await api.request<{
          ready: boolean;
          authorizationUrl?: string;
        }>(`/expert-versions/${version}/connections/${item.name}`, "POST", {
          values: values[item.name] ?? {},
        });
        if (result.authorizationUrl) setAuthorization(result.authorizationUrl);
      }
      setValues((old) => ({ ...old, [item.name]: {} }));
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <Stack spacing={4}>
      <Text fontWeight={600}>网络与外部连接</Text>
      <Text color="muted" fontSize="sm">
        技能需要下载资料时，在这里允许所需域名。仅影响此包的工作环境，下一轮生效。
      </Text>
      <Input
        aria-label="允许访问的域名"
        placeholder="例如 raw.githubusercontent.com，多个域名用逗号分隔"
        value={network}
        onChange={(event) => setNetwork(event.target.value)}
      />
      <Button
        alignSelf="start"
        variant="outline"
        isLoading={networkBusy}
        onClick={() => {
          setNetworkBusy(true);
          setError("");
          void api
            .request(`/expert-versions/${version}/network`, "POST", {
              domains: network
                .split(/[\s,，]+/)
                .map((value) => value.trim())
                .filter(Boolean),
            })
            .catch((error) => setError(String(error)))
            .finally(() => setNetworkBusy(false));
        }}
      >
        保存网络范围
      </Button>
      {error && (
        <Alert status="error">
          <AlertIcon />
          {error}
        </Alert>
      )}
      {unavailable.length > 0 && (
        <Alert status="warning">
          <AlertIcon />
          尚未接入的 WorkBuddy 连接器：{unavailable.join("、")}
          。原包保留，不能忽略依赖开始对话。
        </Alert>
      )}
      {items.map((item) => (
        <Box key={item.name} borderWidth="1px" borderRadius="lg" p={4}>
          <Stack>
            <HStack>
              <Text fontWeight={600}>{item.displayName}</Text>
              <Text color="muted">{item.ready ? "已连接" : "待连接"}</Text>
            </HStack>
            <Text color="muted" fontSize="sm">
              {item.description}
            </Text>
            {!item.ready &&
              item.auth.tokenSchema?.fields?.map((field) => (
                <Input
                  key={field.key}
                  aria-label={label(field.label, field.key)}
                  placeholder={label(field.label, field.key)}
                  type={field.type === "password" ? "password" : "text"}
                  autoComplete="off"
                  value={values[item.name]?.[field.key] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setValues((old) => ({
                      ...old,
                      [item.name]: { ...old[item.name], [field.key]: value },
                    }));
                  }}
                />
              ))}
            <Button
              alignSelf="start"
              variant="outline"
              isLoading={busy === item.name}
              isDisabled={!!busy && busy !== item.name}
              onClick={() => void change(item)}
            >
              {item.ready
                ? "断开连接"
                : item.auth.type === "oauth"
                  ? "连接并授权"
                  : "连接"}
            </Button>
          </Stack>
        </Box>
      ))}
      {authorization && (
        <Button
          as="a"
          href={authorization}
          target="_blank"
          rel="noopener noreferrer"
        >
          前往服务商完成授权
        </Button>
      )}
    </Stack>
  );
}
