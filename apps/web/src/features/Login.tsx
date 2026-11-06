import { useState } from "react";
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Heading,
  Input,
  Stack,
  Text,
  Alert,
  AlertIcon,
} from "@chakra-ui/react";
import { ApiError } from "../../../../src/clients/service-client.js";
import type { BrowserApi, LoginConfig } from "../state/api.js";
import { explain } from "../state/workspace.js";
import { Mark } from "../shared/ui.js";
export function Login({
  api,
  config,
  signedIn,
  initialError,
}: {
  api: BrowserApi;
  config: LoginConfig;
  signedIn: (userId: string) => void;
  initialError?: string;
}) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const token = key;
    setKey("");
    try {
      signedIn((await api.login(token)).userId);
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  }
  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      signedIn((await api.passwordLogin(email, password, register)).userId);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 429) setError("操作过于频繁，请稍后重试。");
      else if (failure instanceof ApiError && failure.status === 401) setError("邮箱或密码错误，或账号不可用。");
      else if (failure instanceof ApiError && failure.status === 409) setError("无法创建账号，请检查邮箱或尝试登录。");
      else if (register && failure instanceof ApiError && failure.status >= 500)
        setError("暂时无法完成注册。如果账号已经创建，请稍后尝试登录。");
      else setError(explain(failure));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  return (
    <Box
      minH="100dvh"
      display="grid"
      placeItems="center"
      p={6}
      bg="canvas"
    >
      <Box
        w="full"
        maxW="432px"
        bg="surface"
        border="1px solid"
        borderColor="line"
        borderRadius="xl"
        p={{ base: 7, md: 10 }}
        boxShadow="lg"
      >
        <Stack spacing={6}>
          <Mark />
          <Box>
            <Heading fontSize="26px" fontWeight={650} mb={2}>
              欢迎使用 Agent Harbor
            </Heading>
            <Text color="muted" fontSize="15px">
              登录工作台，继续你的对话和工作。
            </Text>
          </Box>
          {error && (
            <Alert status="error" borderRadius="md">
              <AlertIcon />
              {error}
            </Alert>
          )}
          {config.passwordLogin && (
            <form onSubmit={submitPassword}>
              <Stack spacing={4}>
                <FormControl isRequired>
                  <FormLabel>邮箱</FormLabel>
                  <Input type="email" autoComplete="username" maxLength={254} value={email}
                    onChange={(event) => setEmail(event.target.value)} />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>密码</FormLabel>
                  <Input type="password" autoComplete={register ? "new-password" : "current-password"}
                    minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
                </FormControl>
                <Button type="submit" isLoading={busy}>{register ? "创建账号并登录" : "登录工作台"}</Button>
                {config.registration && (
                  <Button type="button" variant="ghost" isDisabled={busy} onClick={() => {
                    setRegister(!register);
                    setError(undefined);
                    setPassword("");
                  }}>{register ? "已有账号，返回登录" : "创建账号"}</Button>
                )}
              </Stack>
            </form>
          )}
          {!register && config.oidc && (
            <Button as="a" href="/api/auth/oidc/start">
              使用统一身份登录
            </Button>
          )}
          {!register && config.keyLogin && (
            <form onSubmit={login}>
              <Stack spacing={5}>
                <FormControl isRequired>
                  <FormLabel>开发访问密钥</FormLabel>
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder="输入管理员提供的访问密钥"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </FormControl>
                <Button type="submit" w="full" isLoading={busy}>
                  登录工作台
                </Button>
              </Stack>
            </form>
          )}
          <Text fontSize="13px" color="muted">
            每个用户拥有独立的会话和文件。关闭页面后，已提交的任务仍可继续运行。
          </Text>
        </Stack>
      </Box>
    </Box>
  );
}
