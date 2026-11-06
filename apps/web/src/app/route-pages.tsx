/** URL 选择会话；原 Workspace 继续负责历史、流事件和请求归属。 */
import { useEffect } from "react";
import { Box, Button, Heading, Spinner, Stack, Text } from "@chakra-ui/react";
import { Link, Navigate, useParams } from "react-router";
import { Chat } from "../features/Chat.js";
import { NewEntry } from "../features/NewEntry.js";
import { useWorkbench } from "./workbench-context.js";

export function HomePage() {
  return <NewEntry />;
}

export function ConversationPage() {
  const { sessionId } = useParams();
  const { bench, showFiles, notify, composer, closeEnvironment } =
    useWorkbench();
  const { work } = bench;
  const app = sessionId ? work.applicationFor(sessionId) : undefined;
  useEffect(() => {
    if (
      work.appsLoaded &&
      !work.loadingList &&
      sessionId &&
      !work.applicationFor(sessionId) &&
      work.sessions.has(sessionId) &&
      work.selectedId !== sessionId
    )
      void work.select(sessionId);
  }, [
    work,
    sessionId,
    work.loadingList,
    work.selectedId,
    work.appsLoaded,
    work.applications.size,
  ]);
  // 应用会话由编辑页自己的 Workspace 接管；先等映射确认，避免先闪出普通对话。
  if (work.loadingList || (sessionId && !work.appsLoaded))
    return <Spinner m={8} />;
  if (app && sessionId)
    return <Navigate to={`/applications/${app.id}`} replace />;
  if (!sessionId || !work.sessions.has(sessionId))
    return (
      <Stack p={8} spacing={4} align="flex-start">
        <Heading size="md">找不到这个会话</Heading>
        <Text color="muted" fontSize="13px">
          会话可能不存在，或不属于当前账号。
        </Text>
        <Button as={Link} to="/">
          返回工作台
        </Button>
      </Stack>
    );
  if (work.selectedId !== sessionId || !work.current) return <Spinner m={8} />;
  return (
    <Chat
      bench={bench}
      showFiles={showFiles}
      notify={notify}
      composerRef={composer}
      onCloseEnvironment={closeEnvironment}
    />
  );
}

export function NotFound() {
  return (
    <Box p={8}>
      <Heading size="md" mb={2}>
        页面不存在
      </Heading>
      <Text color="muted" fontSize="13px" mb={4}>
        地址可能已变化，返回工作台继续。
      </Text>
      <Button as={Link} to="/">
        返回工作台
      </Button>
    </Box>
  );
}
