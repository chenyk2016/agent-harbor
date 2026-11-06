import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Flex, Spinner, Text, useToast } from "@chakra-ui/react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { ConversationPage, HomePage } from "./route-pages.js";
import { ExpertsPage } from "../features/experts/ExpertsPage.js";
import { ExpertRoute } from "../features/experts/ExpertPage.js";
import { McpPage } from "../features/mcp/McpPage.js";
import { SkillsPage } from "../features/skills/SkillsPage.js";
import { AccountUsage } from "../features/settings/AccountUsage.js";
import { AccessKeys } from "../features/settings/AccessKeys.js";
import { Appearance } from "../features/settings/Appearance.js";
import { About } from "../features/settings/About.js";
import { BrowserApi, type LoginConfig } from "../state/api.js";
import { Login } from "../features/Login.js";
import { Workbench } from "../features/Workbench.js";
import { ApplicationsPage } from "../features/applications/ApplicationsPage.js";
import { ApplicationRoute } from "../features/applications/ApplicationEditor.js";
import { ModelsPage } from "../features/llm/ModelsPage.js";
import { AdminLayout } from "../features/admin/AdminLayout.js";
import { AdminModels } from "../features/admin/AdminModels.js";
import { AdminUsers } from "../features/admin/AdminUsers.js";
import { AdminBilling } from "../features/admin/AdminBilling.js";
import { AdminOverview } from "../features/admin/AdminOverview.js";
import { AdminRequests } from "../features/admin/AdminRequests.js";
import { AdminOperationsPage } from "../features/admin/AdminOperations.js";
import { AdminActivity } from "../features/admin/AdminActivity.js";
import { AdminUsage } from "../features/admin/AdminUsage.js";
import { AdminAudit } from "../features/admin/AdminAudit.js";
const api = new BrowserApi();
export function App() {
  const navigate = useNavigate();
  const [user, setUser] = useState<string | null>();
  const [config, setConfig] = useState<LoginConfig>();
  const [configError, setConfigError] = useState(false);
  const [loginError] = useState(
    new URL(location.href).searchParams.get("login") === "failed"
      ? "登录未完成或账号已停用，请重试。"
      : undefined,
  );
  const generation = useRef(0);
  const toast = useToast();
  const notify = useCallback(
    (text: string) => {
      toast({
        description: text,
        status: "info",
        duration: 5000,
        isClosable: true,
        position: "top",
      });
    },
    [toast],
  );
  const expired = useCallback(() => {
    generation.current++;
    api.bindUser();
    setUser(null);
  }, []);
  const signedIn = useCallback((id: string) => {
    generation.current++;
    api.bindUser(id);
    setUser(id);
  }, []);
  useEffect(() => {
    let alive = true;
    const version = generation.current;
    void api
      .request<LoginConfig>("/auth/config")
      .then((value) => {
        if (alive) setConfig(value);
      })
      .catch(() => {
        if (alive) setConfigError(true);
      });
    void api
      .me()
      .then(({ userId }) => {
        if (alive && version === generation.current) signedIn(userId);
      })
      .catch(() => {
        if (alive && version === generation.current) setUser(null);
      });
    if (loginError) navigate("/", { replace: true });
    return () => {
      alive = false;
    };
  }, [signedIn, loginError, navigate]);
  // 浏览器恢复缓存页时重新核对Cookie，不能恢复另一个账号的旧画面。
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  if (configError)
    return (
      <Flex minH="100dvh" align="center" justify="center">
        <Box textAlign="center">
          <Text mb={4}>无法读取服务配置，请确认服务运行后重试。</Text>
          <Button onClick={() => location.reload()}>重新连接</Button>
        </Box>
      </Flex>
    );
  if (!config || user === undefined)
    return (
      <Flex minH="100dvh" align="center" justify="center">
        <Spinner color="brand.500" />
      </Flex>
    );
  return user ? (
    <Routes>
      <Route
        path="admin"
        element={
          <AdminLayout
            key={user}
            api={api}
            userId={user}
            expired={expired}
            notify={notify}
          />
        }
      >
        <Route index element={<AdminOverview />} />
        <Route path="models" element={<AdminModels />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="billing" element={<AdminBilling />} />
        <Route path="requests" element={<AdminRequests />} />
        <Route path="operations" element={<AdminOperationsPage />} />
        <Route path="activity" element={<AdminActivity />} />
        <Route path="usage" element={<AdminUsage />} />
        <Route path="audit" element={<AdminAudit />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
      <Route
        element={
          <Workbench
            key={user}
            api={api}
            userId={user}
            expired={expired}
            notify={notify}
          />
        }
      >
        <Route index element={<HomePage />} />
        <Route path="sessions/:sessionId" element={<ConversationPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="skills/:skillId" element={<SkillsPage />} />
        <Route path="experts" element={<ExpertsPage />} />
        <Route path="experts/new" element={<ExpertRoute />} />
        <Route path="experts/:expertId" element={<ExpertRoute />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="mcp" element={<McpPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="applications/:appId" element={<ApplicationRoute />} />
        <Route
          path="settings"
          element={<Navigate to="/settings/account" replace />}
        />
        <Route path="settings/account" element={<AccountUsage />} />
        <Route path="settings/keys" element={<AccessKeys />} />
        <Route path="settings/appearance" element={<Appearance />} />
        <Route path="settings/about" element={<About />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  ) : (
    <Login
      api={api}
      config={config}
      signedIn={signedIn}
      initialError={loginError}
    />
  );
}
