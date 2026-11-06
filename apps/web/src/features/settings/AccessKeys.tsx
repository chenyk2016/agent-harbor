/** CLI 访问密钥：只在创建时显示一次明文。 */
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  Input,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Copy, KeyRound, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "../../app/workbench-context.js";
import { PageHeader } from "../shell/PageHeader.js";
import { Hint, SectionLabel } from "../../shared/ui.js";
import { explain } from "../../state/workspace.js";

interface Key {
  id: string;
  name: string;
  expiresAt: number | null;
  revoked: number;
}

export function AccessKeys() {
  const { api, problem, notify } = useWorkbench();
  const alive = useRef(true);
  const [keys, setKeys] = useState<Key[]>([]);
  const [version, refresh] = useState(0);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void api
      .request<Key[]>("/account/keys", "GET", undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setKeys(value);
          setError("");
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setError(explain(error));
          problem(error);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, problem, version]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setToken("");
    try {
      const key = await api.request<{ token: string }>(
        "/account/keys",
        "POST",
        { name: name.trim() },
      );
      if (!alive.current) return;
      setToken(key.token);
      setName("");
      refresh((n) => n + 1);
    } catch (error) {
      if (alive.current) {
        setError(explain(error));
        problem(error);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      await api.request(`/account/keys/${id}`, "DELETE");
      if (alive.current) refresh((n) => n + 1);
    } catch (error) {
      if (alive.current) {
        setError(explain(error));
        problem(error);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box maxW="880px" mx="auto" px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }}>
        <PageHeader
          title="访问密钥"
          subtitle="用于 CLI 和脚本访问。密钥只在创建时显示一次，离开页面后无法再次读取。"
          actions={
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<RefreshCw size={14} />}
              onClick={() => refresh((n) => n + 1)}
            >
              刷新
            </Button>
          }
        />

        {error && (
          <Alert status="error" borderRadius="9px" mb={4} fontSize="12px">
            <AlertIcon boxSize="14px" />
            {error}
          </Alert>
        )}

        <Box
          border="1px solid"
          borderColor="line"
          borderRadius="14px"
          bg="surface"
          overflow="hidden"
        >
          {loading ? (
            <Flex p={5}>
              <Spinner size="sm" />
            </Flex>
          ) : keys.length ? (
            keys.map((key) => (
              <Flex
                key={key.id}
                align="center"
                gap={3}
                px={4}
                py={3}
                borderBottom="1px solid"
                borderColor="line"
                _last={{ borderBottom: 0 }}
              >
                <Flex
                  w="30px"
                  h="30px"
                  borderRadius="9px"
                  bg="brand.50"
                  color="brand.600"
                  align="center"
                  justify="center"
                  flexShrink={0}
                >
                  <KeyRound size={15} />
                </Flex>
                <Box minW={0} flex={1}>
                  <Text fontSize="12.5px" fontWeight={550} noOfLines={1}>
                    {key.name === "Imported development key"
                      ? "初始开发密钥"
                      : key.name}
                  </Text>
                  <Text fontSize="10.5px" color="muted" mt="1px">
                    {key.revoked
                      ? "已撤销"
                      : key.expiresAt
                        ? `${new Date(key.expiresAt).toLocaleDateString("zh-CN")} 到期`
                        : "开发凭证 · 无到期时间"}
                  </Text>
                </Box>
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={!!key.revoked || busy}
                  onClick={() => void revoke(key.id)}
                >
                  撤销
                </Button>
              </Flex>
            ))
          ) : (
            <Text px={4} py={5} fontSize="12.5px" color="muted">
              还没有访问密钥。
            </Text>
          )}
        </Box>

        <Box
          as="form"
          onSubmit={create}
          maxW="560px"
          mt={4}
          p="16px 18px"
          border="1px solid"
          borderColor="line"
          borderRadius="14px"
          bg="surface"
        >
          <Text fontSize="13.5px" fontWeight={650}>
            创建新密钥
          </Text>
          <Text fontSize="11.5px" color="muted" mt="3px" mb={4} lineHeight={1.6}>
            默认 30 天有效。建议按设备命名，方便日后单独撤销。
          </Text>
          <SectionLabel>密钥名称</SectionLabel>
          <Input
            placeholder="例如：工作电脑 CLI"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Flex justify="flex-end" mt={4}>
            <Button
              type="submit"
              size="sm"
              leftIcon={<Plus size={14} />}
              isLoading={busy}
            >
              创建 30 天密钥
            </Button>
          </Flex>
        </Box>

        {token && (
          <Alert
            status="success"
            borderRadius="10px"
            mt={4}
            flexDirection="column"
            alignItems="flex-start"
          >
            <AlertIcon />
            <Text fontSize="12px" fontWeight={550}>
              仅显示这一次，请保存。离开页面后清除。
            </Text>
            <Flex w="full" gap={2} mt={2}>
              <Input
                aria-label="新访问密钥"
                value={token}
                isReadOnly
                bg="surface"
                fontFamily="mono"
                fontSize="12px"
                onFocus={(event) => event.target.select()}
              />
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Copy size={14} />}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(token)
                    .then(() => notify("已复制密钥"))
                    .catch(() => notify("复制未完成，请手动选择。"))
                }
              >
                复制
              </Button>
            </Flex>
          </Alert>
        )}

        <Box mt={4}>
          <Hint>
            撤销密钥会立即断开使用该密钥的 CLI 会话；网页登录与已提交任务不受影响。
          </Hint>
        </Box>
      </Box>
    </Box>
  );
}
