/** 管理后台外壳：分组导航、权限核验和移动抽屉；页面标题由各页 PageHeader 提供。 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerOverlay,
  Flex,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  ArrowLeft,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  Wallet,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router";
import type { BrowserApi } from "../../state/api.js";
import { ApiError } from "../../../../../src/clients/service-client.js";
import type { AdminContext } from "./context.js";
import { useChangePreview } from "./ChangePreview.js";

const groups = [
  {
    label: "",
    items: [{ to: "/admin", label: "总览", icon: LayoutDashboard, end: true }],
  },
  {
    label: "账号",
    items: [
      { to: "/admin/users", label: "用户", icon: Users, end: false },
      { to: "/admin/billing", label: "计费设置", icon: Wallet, end: false },
    ],
  },
  {
    label: "平台",
    items: [
      { to: "/admin/models", label: "模型与网关", icon: Sparkles, end: false },
      { to: "/admin/requests", label: "扣费核对", icon: TriangleAlert, end: false },
      { to: "/admin/operations", label: "运行状态", icon: LayoutDashboard, end: false },
      { to: "/admin/activity", label: "请求与历史", icon: Wallet, end: false },
      { to: "/admin/usage", label: "用量与成本", icon: Sparkles, end: false },
      { to: "/admin/audit", label: "管理审计", icon: ShieldCheck, end: false },
    ],
  },
];

export function AdminLayout({
  api,
  userId,
  expired,
  notify,
}: {
  api: BrowserApi;
  userId: string;
  expired(): void;
  notify(text: string): void;
}) {
  const { requestChange, changeDialog } = useChangePreview(api);
  const [allowed, setAllowed] = useState<boolean>();
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const problem = useCallback(
    (e: unknown) => {
      if (
        e instanceof ApiError &&
        (e.status === 401 || e.code === "ACCOUNT_DISABLED")
      )
        expired();
      if (e instanceof ApiError && e.status === 403) setAllowed(false);
    },
    [expired],
  );
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void api
      .me()
      .then((me) => {
        if (!abort.signal.aborted) setAllowed(me.capabilities.managePlatform);
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError("无法确认管理权限，请重试。");
          problem(e);
        }
      });
    return () => abort.abort();
  }, [api, userId, problem, version]);

  if (!allowed)
    return (
      <Flex minH="100dvh" bg="canvas" align="center" justify="center" p={5}>
        <Stack align="center" spacing={4}>
          {allowed === false ? (
            <>
              <ShieldCheck />
              <Text>此账号没有管理后台访问权限。</Text>
            </>
          ) : error ? (
            <>
              <Alert status="error">
                <AlertIcon />
                {error}
              </Alert>
              <Button onClick={() => refresh((n) => n + 1)}>重试</Button>
            </>
          ) : (
            <Spinner />
          )}
          <Button as={NavLink} to="/" variant="outline">
            返回工作台
          </Button>
        </Stack>
      </Flex>
    );

  const context: AdminContext = {
    api,
    userId,
    notify,
    problem,
    openNavigation: () => setOpen(true),
    requestChange,
  };
  const navigation = (
    <Flex direction="column" h="full" bg="surface" p={3} overflowY="auto">
      <Flex align="center" gap={2} px={3} py={4}>
        <ShieldCheck size={20} />
        <Text fontWeight={650} fontSize="14px">
          管理后台
        </Text>
      </Flex>
      <Text fontSize="11px" color="muted" px={3} mb={4}>
        Agent Harbor · 平台管理
      </Text>
      <Stack spacing={4}>
        {groups.map((group) => (
          <Box key={group.label || "root"}>
            {group.label && (
              <Text
                px={3}
                mb={1.5}
                fontSize="10px"
                fontWeight={600}
                letterSpacing=".06em"
                color="muted"
              >
                {group.label}
              </Text>
            )}
            <Stack spacing={1}>
              {group.items.map(({ to, label, icon: Icon, end }) => {
                const active = end ? pathname === to : pathname.startsWith(to);
                return (
                  <Button
                    key={to}
                    as={NavLink}
                    to={to}
                    end={end}
                    variant="ghost"
                    size="sm"
                    h="34px"
                    justifyContent="flex-start"
                    leftIcon={<Icon size={16} />}
                    bg={active ? "brand.50" : undefined}
                    color={active ? "brand.700" : "ink2"}
                    fontWeight={active ? 550 : 450}
                    _hover={{ bg: active ? "brand.50" : "surfaceHover" }}
                    onClick={() => setOpen(false)}
                  >
                    {label}
                  </Button>
                );
              })}
            </Stack>
          </Box>
        ))}
      </Stack>
      <Box flex={1} />
      <Text px={3} my={3} fontSize="11px" color="muted" overflowWrap="anywhere">
        {userId}
      </Text>
      <Button
        as={NavLink}
        to="/"
        variant="outline"
        size="sm"
        leftIcon={<ArrowLeft size={15} />}
      >
        返回工作台
      </Button>
    </Flex>
  );
  return (
    <Flex h="100dvh" bg="canvas" overflow="hidden">
      <Box
        w="220px"
        flexShrink={0}
        display={{ base: "none", lg: "block" }}
        borderRight="1px solid"
        borderColor="line"
        minH={0}
      >
        {navigation}
      </Box>
      <Flex flex={1} minW={0} minH={0}>
        <Outlet context={context} />
          {changeDialog}
      </Flex>
      <Drawer isOpen={open} placement="left" onClose={() => setOpen(false)}>
        <DrawerOverlay />
        <DrawerContent maxW="280px">
          <DrawerBody p={0}>{navigation}</DrawerBody>
        </DrawerContent>
      </Drawer>
    </Flex>
  );
}
