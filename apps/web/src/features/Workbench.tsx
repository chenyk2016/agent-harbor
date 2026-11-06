/** 工作台外壳：图标栏、二级导航、主区和工作区；页面只通过 Outlet 渲染。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerOverlay,
  Flex,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Spinner,
  Stack,
  Text,
  useBreakpointValue,
} from "@chakra-ui/react";
import { Power } from "lucide-react";
import type { BrowserApi } from "../state/api.js";
import { useWorkspace } from "../app/use-workspace.js";
import { Outlet, useLocation, useNavigate } from "react-router";
import type { WorkbenchContext } from "../app/workbench-context.js";
import { explain } from "../state/workspace.js";
import { ApiError } from "../../../../src/clients/service-client.js";
import { Rail } from "./shell/Rail.js";
import { SessionList } from "./shell/SessionList.js";
import { LibraryNav } from "./shell/LibraryNav.js";
import { SettingsNav } from "./shell/SettingsNav.js";
import { CommandPalette } from "./shell/CommandPalette.js";
import {
  WorkspacePanel,
  type WorkspaceTab,
} from "./workspace/WorkspacePanel.js";

export function Workbench({
  api,
  userId,
  expired,
  notify,
}: {
  api: BrowserApi;
  userId: string;
  expired: () => void;
  notify: (text: string) => void;
}) {
  const [canManage, setCanManage] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void api
      .me()
      .then((me) => {
        if (!abort.signal.aborted) setCanManage(me.capabilities.managePlatform);
      })
      .catch(() => setCanManage(false));
    return () => abort.abort();
  }, [api, userId]);
  const bench = useWorkspace(api, userId, expired, notify);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isDesktop = useBreakpointValue({ base: false, lg: true });
  const [navigation, setNavigation] = useState(false);
  const [palette, setPalette] = useState(false);
  const [guide, setGuide] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [closeTarget, setCloseTarget] = useState<{
    id: string;
    messageId: string | null;
    title: string;
  }>();
  const composer = useRef<HTMLTextAreaElement>(null);

  const entryPage = pathname === "/";
  const sessionPage = pathname.startsWith("/sessions/");
  const chatPage = entryPage || sessionPage;
  const libraryPage = ["/skills", "/experts", "/mcp", "/models"].some((path) =>
    pathname.startsWith(path),
  );
  const settingsPage = pathname.startsWith("/settings");
  const showSide = chatPage || libraryPage || settingsPage;

  const problem = useCallback(
    (error: unknown) => {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.code === "ACCOUNT_DISABLED")
      )
        expired();
      else notify(explain(error));
    },
    [expired, notify],
  );

  const openPalette = useCallback(() => setPalette(true), []);
  const openNavigation = useCallback(() => setNavigation(true), []);
  const openWorkspace = useCallback(() => {
    if (isDesktop) setContextOpen((value) => !value);
    else setPanelOpen(true);
  }, [isDesktop]);
  const openGuide = useCallback(() => setGuide(true), []);
  // 新建入口只有一个：导航到总入口；同一路径重复点击也会产生新的 location.key。
  const openNew = useCallback(
    (mode: "chat" | "app" = "chat") => {
      navigate(`/?mode=${mode}`, { state: { at: Date.now() } });
    },
    [navigate],
  );

  const showFiles = useCallback(() => {
    if (tab === "files") bench?.files.show(true);
    else setTab("files");
    if (isDesktop) setContextOpen(true);
    else setPanelOpen(true);
  }, [bench, isDesktop, tab]);

  const closeEnvironment = useCallback(() => {
    const state = bench?.work.current;
    if (state)
      setCloseTarget({
        id: state.id,
        messageId: state.detail.lastMessageId,
        title: state.detail.title,
      });
  }, [bench]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((value) => !value);
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        openNew("chat");
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [openNew]);

  async function logout() {
    if (!bench) return;
    try {
      await bench.work.logout();
      bench.files.clear();
    } catch (error) {
      notify(explain(error));
    }
  }

  if (!bench)
    return (
      <Flex h="100dvh" justify="center" align="center" bg="canvas">
        <Spinner color="brand.500" />
      </Flex>
    );

  const work = bench.work;
  const side = chatPage ? (
    <SessionList
      bench={bench}
      onNew={() => openNew("chat")}
      notify={notify}
      onNavigated={() => setNavigation(false)}
    />
  ) : libraryPage ? (
    <LibraryNav />
  ) : settingsPage ? (
    <SettingsNav onLogout={() => void logout()} />
  ) : null;

  const context: WorkbenchContext = {
    bench,
    api,
    problem,
    notify,
    composer,
    openNew,
    showFiles,
    created: async (id) => {
      await work.refreshList();
      navigate(`/sessions/${id}`);
    },
    openNavigation,
    openWorkspace,
    openPalette,
    openGuide,
    closeEnvironment,
  };

  return (
    <Flex h="100dvh" overflow="hidden" bg="canvas">
      <Rail
        userId={userId}
        canManage={canManage}
        onPalette={openPalette}
        onLogout={() => void logout()}
      />

      {showSide && (
        <Box
          w="292px"
          flexShrink={0}
          borderRight="1px solid"
          borderColor="line"
          display={{ base: "none", lg: "block" }}
          minH={0}
        >
          {side}
        </Box>
      )}

      <Flex direction="column" flex={1} minW={0} minH={0}>
        <Outlet context={context} />
      </Flex>

      {sessionPage && contextOpen && (
        <Box
          w="372px"
          flexShrink={0}
          borderLeft="1px solid"
          borderColor="line"
          bg="surface"
          display={{ base: "none", lg: "flex" }}
          flexDirection="column"
          minH={0}
        >
          <WorkspacePanel
            bench={bench}
            tab={tab}
            setTab={setTab}
            closeEnvironment={closeEnvironment}
            onClose={openWorkspace}
          />
        </Box>
      )}

      <Drawer
        isOpen={navigation}
        placement="left"
        onClose={() => setNavigation(false)}
        size="xs"
      >
        <DrawerOverlay />
        <DrawerContent maxW="300px" bg="surface">
          <DrawerBody p={0}>{side}</DrawerBody>
        </DrawerContent>
      </Drawer>

      <Drawer
        isOpen={panelOpen}
        placement="right"
        onClose={() => setPanelOpen(false)}
        size="sm"
      >
        <DrawerOverlay />
        <DrawerContent maxW="372px" bg="surface">
          <DrawerBody p={0}>
            <WorkspacePanel
              bench={bench}
              tab={tab}
              setTab={setTab}
              closeEnvironment={closeEnvironment}
              onClose={() => setPanelOpen(false)}
            />
          </DrawerBody>
        </DrawerContent>
      </Drawer>

      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        bench={bench}
        openNew={openNew}
        onLogout={() => void logout()}
      />

      <Modal isOpen={!!closeTarget} onClose={() => setCloseTarget(undefined)}>
        <ModalOverlay />
        <ModalContent mx={4}>
          <ModalHeader>关闭工作环境？</ModalHeader>
          <ModalCloseButton aria-label="关闭弹窗" />
          <ModalBody>
            <Text fontSize="13.5px">
              「{closeTarget?.title}」中的所有容器进程将停止，对话和文件保留。
            </Text>
            <Text mt={3} color="muted" fontSize="12px">
              只想结束当前任务，请使用「停止本轮」。关闭环境不会撤销已经发生的修改。
            </Text>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setCloseTarget(undefined)}>
              暂不关闭
            </Button>
            <Button
              variant="danger"
              leftIcon={<Power size={15} />}
              onClick={() => {
                const target = closeTarget;
                setCloseTarget(undefined);
                if (target) void work.close(target.id, target.messageId);
              }}
            >
              关闭环境
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={guide} onClose={() => setGuide(false)} size="lg">
        <ModalOverlay />
        <ModalContent mx={4}>
          <ModalHeader>让工作持续向前</ModalHeader>
          <ModalCloseButton aria-label="关闭弹窗" />
          <ModalBody>
            <Stack spacing={4}>
              {[
                [
                  "发送任务",
                  "Enter 发送，Shift + Enter 换行；⌘/Ctrl + Enter 也可发送。每个会话同时执行一条消息。",
                ],
                [
                  "文件与成果",
                  "上传资料后，文件会在输入区显示状态。生成文件可在工作区「文件」里预览和下载。",
                ],
                [
                  "停止本轮",
                  "优先结束当前执行，正常中断后保留环境。独立后台进程可能仍在运行。",
                ],
                [
                  "关闭环境",
                  "在会话菜单或工作区概览中关闭。停止全部容器进程，保留对话和文件。",
                ],
                [
                  "断线与重连",
                  "关闭页面不会停止任务。重连后补看保存的进度；提交结果未知时核对并重试原请求。",
                ],
              ].map(([heading, text]) => (
                <Box key={heading}>
                  <Text fontWeight={600} fontSize="13px" mb={1}>
                    {heading}
                  </Text>
                  <Text color="muted" fontSize="12px" lineHeight={1.7}>
                    {text}
                  </Text>
                </Box>
              ))}
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button onClick={() => setGuide(false)}>知道了</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Flex>
  );
}
