/** 会话列表：置顶、时间分组、搜索及直接删除；应用会话统一删除所属应用。 */
import { useState } from "react";
import { DeleteResourceDialog } from "../deletions/DeleteResource.js";
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Input,
  InputGroup,
  InputLeftElement,
  InputRightElement,
  Kbd,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Text,
} from "@chakra-ui/react";
import {
  Copy,
  Gauge,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router";
import type { Workbench } from "../../app/use-workspace.js";
import { clock, StatusDot } from "../../shared/ui.js";
import { isActive } from "../../state/conversation-state.js";
import type { SessionDetail } from "../../../../../src/clients/service-client.js";

const DAY = 86_400_000;

function groupSessions(
  items: SessionDetail[],
  pinned: (id: string) => boolean,
) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const yesterday = today - DAY;
  const pin: SessionDetail[] = [];
  const now: SessionDetail[] = [];
  const before: SessionDetail[] = [];
  const older: SessionDetail[] = [];
  for (const item of items) {
    if (pinned(item.id)) pin.push(item);
    else if (item.updatedAt >= today) now.push(item);
    else if (item.updatedAt >= yesterday) before.push(item);
    else older.push(item);
  }
  return [
    { label: "置顶", icon: true, items: pin },
    { label: "今天", icon: false, items: now },
    { label: "昨天", icon: false, items: before },
    { label: "更早", icon: false, items: older },
  ].filter((group) => group.items.length > 0);
}

function metaLabel(item: SessionDetail) {
  if (item.deletionState) return item.deletionState === "failed" ? "删除未完成" : "正在删除";
  if (!item.message) return "尚未发送";
  if (isActive(item.message)) return "正在执行";
  switch (item.message.status) {
    case "succeeded":
      return "已完成";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已停止";
    case "interrupted":
      return "执行中断";
    case "reconciling":
      return "结果待确认";
    default:
      return "已接收";
  }
}

function metaColor(item: SessionDetail) {
  if (!item.message) return "muted";
  if (isActive(item.message)) return "brand.600";
  if (item.message.status === "failed") return "dangerStrong";
  if (item.message.status === "reconciling") return "warnStrong";
  return "muted";
}

function timeLabel(time: number) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return clock(time);
  if (time >= start.getTime() - DAY) return "昨天";
  return new Date(time).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

export function SessionList({
  bench,
  onNew,
  notify,
  onNavigated,
}: {
  bench: Workbench;
  onNew: () => void;
  notify: (text: string) => void;
  onNavigated?: () => void;
}) {
  const { work } = bench;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const groups = groupSessions(work.visible, (id) => work.pinned(id));
  const [deleting, setDeleting] = useState<{ kind: "session" | "application"; id: string; title: string; sessionId?: string }>();

  const copyLink = async (id: string) => {
    const url = `${location.origin}/sessions/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      notify("已复制会话链接");
    } catch {
      notify("复制未完成，请手动选择地址。");
    }
  };

  return (
    <Flex direction="column" h="full" minH={0} bg="surface">
      <Flex align="center" gap={2} px={3} pt="14px" pb="10px" flexShrink={0}>
        <Text fontSize="14.5px" fontWeight={650} letterSpacing="-.01em">
          会话
        </Text>
        <Box flex={1} />
        <IconButton
          aria-label="新建对话或应用"
          variant="ghost"
          size="sm"
          icon={<Plus size={17} />}
          onClick={onNew}
        />
      </Flex>

      <Box px={3} pb={2} flexShrink={0}>
        <InputGroup size="sm">
          <InputLeftElement pointerEvents="none" h="34px">
            <Search size={15} color="var(--ah-muted)" />
          </InputLeftElement>
          <Input
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={work.query}
            onChange={(event) => {
              work.query = event.target.value;
              bench.changed();
            }}
            bg="sunken"
            borderColor="transparent"
            h="34px"
            fontSize="13px"
            _hover={{ bg: "surfaceHover" }}
            _focus={{ bg: "surface", borderColor: "brand.500" }}
          />
          <InputRightElement
            pointerEvents="none"
            h="34px"
            display={{ base: "none", md: "flex" }}
          >
            <Kbd fontSize="10px">⌘K</Kbd>
          </InputRightElement>
        </InputGroup>
      </Box>

      <Box flex={1} minH={0} overflowY="auto" px={2} pb={4}>
        {groups.map((group) => (
          <Box key={group.label}>
            <HStack spacing="6px" px={2} pt="14px" pb="5px">
              {group.icon && <Pin size={12} color="var(--ah-muted)" />}
              <Text fontSize="11px" fontWeight={600} color="muted">
                {group.label}
              </Text>
              <Box flex={1} />
              <Text fontSize="10.5px" color="lineStrong">
                {group.items.length}
              </Text>
            </HStack>
            {group.items.map((item) => {
              const app = work.applicationFor(item.id);
              const href = app
                ? `/applications/${app.id}`
                : `/sessions/${item.id}`;
              const active = pathname === href;
              const pinned = work.pinned(item.id);
              return (
                <Flex
                  key={item.id}
                  role="group"
                  align="stretch"
                  borderRadius="9px"
                  bg={active ? "brand.50" : undefined}
                  _hover={{ bg: active ? "brand.50" : "surfaceHover" }}
                >
                  <Box
                    as={NavLink}
                    to={href}
                    onClick={onNavigated}
                    flex={1}
                    minW={0}
                    display="flex"
                    gap="9px"
                    px="10px"
                    py="8px"
                    borderRadius="9px"
                    _focusVisible={{
                      boxShadow: "0 0 0 2px var(--ah-focus)",
                    }}
                  >
                    <Box position="relative" mt="1px" flexShrink={0}>
                      <Flex
                        w="22px"
                        h="22px"
                        borderRadius="6px"
                        align="center"
                        justify="center"
                        bg={app ? "brand.50" : "sunken"}
                        color={app ? "brand.600" : "muted"}
                        role="img"
                        aria-label={app ? "应用会话" : "普通对话"}
                        title={app ? "应用会话" : "普通对话"}
                      >
                        {app ? (
                          <LayoutGrid size={13} />
                        ) : (
                          <MessageSquare size={13} />
                        )}
                      </Flex>
                      <Box
                        position="absolute"
                        right="-2px"
                        bottom="-2px"
                        p="1.5px"
                        bg="surface"
                        borderRadius="full"
                      >
                        <StatusDot message={item.message} />
                      </Box>
                    </Box>
                    <Box minW={0}>
                      <Text
                        fontSize="13.5px"
                        fontWeight={active ? 550 : 500}
                        color={active ? "brand.700" : "ink"}
                        noOfLines={1}
                        lineHeight={1.45}
                      >
                        {item.title}
                      </Text>
                      <HStack spacing="5px" mt="2px" fontSize="11px">
                        <Text color={metaColor(item)} noOfLines={1}>
                          {metaLabel(item)}
                        </Text>
                        <Text color="muted">·</Text>
                        <Text color="muted">
                          {timeLabel(item.updatedAt)}
                        </Text>
                      </HStack>
                    </Box>
                  </Box>
                  <Menu placement="bottom-end">
                    <MenuButton
                      as={IconButton}
                      aria-label={`${item.title} 的会话菜单`}
                      variant="ghost"
                      size="sm"
                      ml="-2px"
                      mr="4px"
                      alignSelf="center"
                      opacity={active ? 1 : 0}
                      _groupHover={{ opacity: 1 }}
                      _focusVisible={{ opacity: 1 }}
                      icon={<MoreHorizontal size={15} />}
                    />
                    <MenuList fontSize="13px" minW="180px">
                      <MenuItem
                        icon={pinned ? <PinOff size={15} /> : <Pin size={15} />}
                        onClick={() => {
                          work.togglePin(item.id);
                          notify(pinned ? "已取消置顶" : "已置顶");
                        }}
                      >
                        {pinned ? "取消置顶" : "置顶会话"}
                      </MenuItem>
                      <MenuItem
                        icon={<Copy size={15} />}
                        onClick={() => void copyLink(item.id)}
                      >
                        复制会话链接
                      </MenuItem>
                      <MenuItem
                        icon={<Gauge size={15} />}
                        onClick={() => navigate("/settings/account")}
                      >
                        查看用量
                      </MenuItem>
                      <MenuItem color="red.600" icon={<Trash2 size={15}/>} onClick={()=>setDeleting(app
                        ? {kind:"application",id:app.id,title:app.title,sessionId:item.id}
                        : {kind:"session",id:item.id,title:item.title})}>
                        {item.deletionState === "failed" ? "重试删除" : app ? "删除应用" : "删除对话"}
                      </MenuItem>
                    </MenuList>
                  </Menu>
                </Flex>
              );
            })}
          </Box>
        ))}

        {!work.visible.length && (
          <Box px={3} py={5}>
            <Text fontSize="12.5px" color="muted" lineHeight={1.7}>
              {work.loadingList
                ? "正在读取会话…"
                : (work.listError ??
                  (work.query
                    ? "没有匹配的会话"
                    : "还没有会话，开始一项工作吧。"))}
            </Text>
            {work.query ? (
              <Button
                mt={2}
                size="sm"
                variant="link"
                onClick={() => {
                  work.query = "";
                  bench.changed();
                }}
              >
                清除搜索
              </Button>
            ) : (
              !work.loadingList &&
              !work.listError && (
                <Button
                  mt={2}
                  size="sm"
                  variant="outline"
                  leftIcon={<Plus size={14} />}
                  onClick={onNew}
                >
                  开始新对话
                </Button>
              )
            )}
          </Box>
        )}
      </Box>

      <Flex
        borderTop="1px solid"
        borderColor="line"
        px={3}
        py={3}
        flexShrink={0}
      >
        <Button
          as={NavLink}
          to="/settings/account"
          variant="ghost"
          size="sm"
          leftIcon={<Gauge size={15} />}
          w="full"
          justifyContent="flex-start"
          color="muted"
          fontWeight={400}
        >
          查看用量与余额
        </Button>
      </Flex>
      {deleting&&<DeleteResourceDialog target={deleting} bench={bench} onClose={()=>setDeleting(undefined)} onDeleted={()=>{
        const sid=deleting.kind==='session'?deleting.id:deleting.sessionId;
        if(pathname===`/sessions/${sid}`||pathname===`/applications/${deleting.id}`)navigate("/");
        setDeleting(undefined);notify("已永久删除");
      }}/>}
    </Flex>
  );
}
