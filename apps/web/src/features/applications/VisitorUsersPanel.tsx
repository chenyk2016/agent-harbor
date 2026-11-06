import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Select,
  Spinner,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from "@chakra-ui/react";
import type { ApplicationApi } from "../../state/application-api.js";
import { explain } from "../../state/errors.js";
import type { Endpoint } from "./labels.js";

/** 所有者可见的访客摘要，密码和会话凭据由服务端保管。 */
interface VisitorUser {
  id: string;
  email: string;
  method: "email_password" | "google" | "legacy";
  disabled: boolean;
}

/** 每页只显示当前环境的用户和翻页范围。 */
interface VisitorPage {
  items: VisitorUser[];
  totalPages: number;
}

/** 登录开关保存到平台，随下一次对应环境部署生效。 */
interface VisitorSettings {
  available: boolean;
}

/** 按预览或正式环境查看账号，并通过所有者接口修改登录设置和账号状态。 */
export function VisitorUsersPanel({
  api,
  id,
  preview,
  production,
}: {
  api: ApplicationApi;
  id: string;
  preview: Endpoint;
  production: Endpoint;
}) {
  const [environment, setEnvironment] =
    useState<Endpoint["environment"]>("production");
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    settings: VisitorSettings;
    users?: VisitorPage;
  }>();
  const [error, setError] = useState("");
  const path = `/applications/${id}/auth/${environment}`;
  const key = `${path}:${page}:${revision}`;
  const active = result?.key === key ? result : undefined;
  const endpoint = environment === "preview" ? preview : production;

  useEffect(() => {
    const request = new AbortController();
    setError("");
    api
      .request<VisitorSettings>(path, "GET", undefined, request.signal)
      .then(async (settings) => {
        if (request.signal.aborted) return;
        setResult({ key, settings });
        if (!settings.available) return;
        const users = await api.request<VisitorPage>(
          `${path}/users?page=${page}`,
          "GET",
          undefined,
          request.signal,
        );
        if (!request.signal.aborted) setResult({ key, settings, users });
      })
      .catch((value: unknown) => {
        if (!request.signal.aborted) setError(explain(value));
      });
    return () => request.abort();
  }, [api, key, page, path]);

  /** 刷新账号状态和设置，等后台确认后再改变页面。 */
  async function update(target: string, body: object) {
    setPending(true);
    setError("");
    try {
      await api.request(target, "PATCH", body);
      setRevision((value) => value + 1);
    } catch (value) {
      setError(explain(value));
    } finally {
      setPending(false);
    }
  }

  return (
    <Box p={{ base: 4, app: 6 }}>
      <Flex gap={3} wrap="wrap" align="center" mb={3}>
        <Text as="h2" fontSize="lg" fontWeight="semibold">
          访客用户
        </Text>
        <Select
          aria-label="用户环境"
          w="auto"
          size="sm"
          value={environment}
          isDisabled={pending}
          onChange={(event) => {
            setEnvironment(
              event.target.value === "preview" ? "preview" : "production",
            );
            setPage(1);
          }}
        >
          <option value="production">正式环境</option>
          <option value="preview">预览环境</option>
        </Select>
      </Flex>
      {error && (
        <Text role="alert" color="dangerStrong" mb={3}>
          {error}
        </Text>
      )}
      {active ? (
        active.settings.available ? (
          <>
            <Text mb={4} color="muted">
              {endpoint.requiresLogin
                ? `当前部署要求登录${
                    endpoint.loginProviders?.length
                      ? " · " +
                        endpoint.loginProviders
                          .map((provider) =>
                            provider === "google" ? "Google" : "邮箱密码",
                          )
                          .join("、")
                      : ""
                  }`
                : "当前入口未启用登录"}
            </Text>
            {!active.users ? (
              !error && <Spinner size="sm" />
            ) : active.users.items.length ? (
              <Box overflowX="auto">
                <Table size="sm" aria-label="访客用户">
                  <Thead>
                    <Tr>
                      <Th>邮箱</Th>
                      <Th>登录来源</Th>
                      <Th>账号状态</Th>
                      <Th>操作</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {active.users.items.map((user) => (
                      <Tr key={user.id}>
                        <Td>{user.email}</Td>
                        <Td>
                          {user.method === "google"
                            ? "Google"
                            : user.method === "email_password"
                              ? "邮箱密码"
                              : "历史账号"}
                        </Td>
                        <Td>{user.disabled ? "已停用" : "正常"}</Td>
                        <Td>
                          <Button
                            size="xs"
                            variant="outline"
                            isDisabled={pending}
                            aria-label={`${user.disabled ? "恢复" : "停用"} ${user.email}`}
                            onClick={() =>
                              void update(
                                `${path}/users/${encodeURIComponent(user.id)}`,
                                { disabled: !user.disabled },
                              )
                            }
                          >
                            {user.disabled ? "恢复" : "停用"}
                          </Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              </Box>
            ) : (
              <Text color="muted">当前页暂无用户。</Text>
            )}
            {active.users && active.users.totalPages > 1 && (
              <Flex mt={4} gap={3} align="center">
                <Button
                  size="xs"
                  isDisabled={pending || page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
                <Text fontSize="sm">第 {page} 页</Text>
                <Button
                  size="xs"
                  isDisabled={pending || page >= active.users.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </Flex>
            )}
          </>
        ) : (
          <Text color="muted">此平台尚未配置访客登录。</Text>
        )
      ) : error ? (
        <Button size="sm" onClick={() => setRevision((value) => value + 1)}>
          重试
        </Button>
      ) : (
        <Spinner size="sm" />
      )}
    </Box>
  );
}
