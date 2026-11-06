/** 命令面板：只聚合已有页面、会话和本地操作，不新增网络请求。 */
import {
  Box,
  Flex,
  Input,
  Kbd,
  Portal,
  Text,
  useColorMode,
} from "@chakra-ui/react";
import {
  ChartColumn,
  Layers,
  LayoutGrid,
  LogOut,
  MessageSquare,
  Moon,
  Plug,
  Plus,
  Search,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Workbench } from "../../app/use-workspace.js";
import { setThemePreference } from "../../app/theme-mode.js";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  text: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  bench,
  openNew,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  bench: Workbench;
  openNew: (mode?: "chat" | "app") => void;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const { colorMode } = useColorMode();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    const timer = window.setTimeout(() => input.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (path: string) => () => {
      onClose();
      navigate(path);
    };
    const pages: Item[] = [
      {
        id: "page-chat",
        group: "页面",
        label: "总入口",
        icon: <MessageSquare size={16} />,
        text: "会话 对话 工作台 新建 chat",
        run: go("/"),
      },
      {
        id: "page-apps",
        group: "页面",
        label: "我的应用",
        icon: <LayoutGrid size={16} />,
        text: "应用 apps 我的应用",
        run: go("/applications"),
      },
      {
        id: "page-skills",
        group: "页面",
        label: "技能",
        icon: <Layers size={16} />,
        text: "技能 skills",
        run: go("/skills"),
      },
      {
        id: "page-experts",
        group: "页面",
        label: "专家",
        icon: <Users size={16} />,
        text: "专家 experts",
        run: go("/experts"),
      },
      {
        id: "page-mcp",
        group: "页面",
        label: "MCP 连接",
        icon: <Plug size={16} />,
        text: "mcp 连接 工具",
        run: go("/mcp"),
      },
      {
        id: "page-models",
        group: "页面",
        label: "模型与网关",
        icon: <Sparkles size={16} />,
        text: "模型 网关 llm model",
        run: go("/models"),
      },
      {
        id: "page-account",
        group: "页面",
        label: "账户与用量",
        icon: <ChartColumn size={16} />,
        text: "设置 用量 账户 account",
        run: go("/settings/account"),
      },
      {
        id: "page-appearance",
        group: "页面",
        label: "外观与主题",
        icon: <Sun size={16} />,
        text: "外观 主题 深色 浅色 appearance theme",
        run: go("/settings/appearance"),
      },
    ];
    const actions: Item[] = [
      {
        id: "new-session",
        group: "操作",
        label: "新建对话或应用",
        hint: "⌘N",
        icon: <Plus size={16} />,
        text: "新建对话 应用 new session app",
        run: () => {
          onClose();
          openNew("chat");
        },
      },
      {
        id: "toggle-theme",
        group: "操作",
        label: colorMode === "dark" ? "切换到浅色" : "切换到深色",
        hint: colorMode === "dark" ? "Light" : "Dark",
        icon: colorMode === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        text: "切换主题 深色 浅色 theme dark light",
        run: () => {
          onClose();
          setThemePreference(colorMode === "dark" ? "light" : "dark");
        },
      },
      {
        id: "logout",
        group: "操作",
        label: "退出登录",
        icon: <LogOut size={16} />,
        text: "退出登录 logout",
        run: () => {
          onClose();
          onLogout();
        },
      },
    ];
    const recent: Item[] = bench.work.visible.slice(0, 3).map((session) => {
      const app = bench.work.applicationFor(session.id);
      return {
        id: `session-${session.id}`,
        group: "最近会话",
        label: session.title,
        hint: app ? "应用" : session.message ? "打开" : "未开始",
        icon: app ? <LayoutGrid size={16} /> : <MessageSquare size={16} />,
        text: `${session.title} ${app ? "应用 app" : ""} ${session.message?.status ?? ""}`,
        run: go(app ? `/applications/${app.id}` : `/sessions/${session.id}`),
      };
    });
    return [...actions, ...pages, ...recent];
  }, [
    bench,
    bench.work.sessions.size,
    bench.work.applications.size,
    colorMode,
    openNew,
    navigate,
    onClose,
    onLogout,
  ]);

  const visible = useMemo(() => {
    const text = query.toLowerCase().trim();
    return text
      ? items.filter((item) =>
          `${item.label} ${item.text}`.toLowerCase().includes(text),
        )
      : items;
  }, [items, query]);

  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((value) =>
          visible.length ? (value + 1) % visible.length : 0,
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((value) =>
          visible.length ? (value - 1 + visible.length) % visible.length : 0,
        );
      } else if (event.key === "Enter") {
        const item = visible[selected];
        if (item) {
          event.preventDefault();
          item.run();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, onClose, selected, visible]);

  if (!open) return null;

  let lastGroup = "";
  return (
    <Portal>
      <Box
        position="fixed"
        inset={0}
        zIndex={1500}
        bg="rgba(0,0,0,.38)"
        display="flex"
        justifyContent="center"
        alignItems="flex-start"
        pt="12vh"
        px={4}
        onMouseDown={onClose}
      >
        <Box
          role="dialog"
          aria-modal="true"
          aria-label="搜索与命令"
          w="560px"
          maxW="100%"
          bg="surface"
          border="1px solid"
          borderColor="line"
          borderRadius="14px"
          boxShadow="lg"
          overflow="hidden"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Flex
            align="center"
            gap={2.5}
            px="14px"
            py="12px"
            borderBottom="1px solid"
            borderColor="line"
          >
            <Search size={16} color="var(--ah-muted)" />
            <Input
              ref={input}
              border={0}
              bg="transparent"
              px={0}
              h="24px"
              fontSize="14px"
              placeholder="搜索会话、页面或命令…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              _focusVisible={{ boxShadow: "none" }}
              aria-label="搜索"
            />
            <Kbd fontSize="10px">Esc</Kbd>
          </Flex>

          <Box maxH="62vh" overflowY="auto" p="6px">
            {visible.map((item, index) => {
              const header = item.group !== lastGroup ? item.group : "";
              lastGroup = item.group;
              return (
                <Box key={item.id}>
                  {header && (
                    <Text
                      fontSize="10px"
                      fontWeight={600}
                      letterSpacing=".05em"
                      color="muted"
                      px="9px"
                      pt="8px"
                      pb="4px"
                    >
                      {header}
                    </Text>
                  )}
                  <Flex
                    as="button"
                    type="button"
                    w="full"
                    align="center"
                    gap="9px"
                    px="9px"
                    py="8px"
                    borderRadius="7px"
                    fontSize="13px"
                    color={index === selected ? "ink" : "ink2"}
                    bg={index === selected ? "surfaceHover" : undefined}
                    textAlign="left"
                    onMouseEnter={() => setSelected(index)}
                    onClick={item.run}
                    _focusVisible={{ boxShadow: "0 0 0 2px var(--ah-focus)" }}
                  >
                    <Box color="muted" display="flex">
                      {item.icon}
                    </Box>
                    <Text flex={1} minW={0} noOfLines={1}>
                      {item.label}
                    </Text>
                    {item.hint && (
                      <Kbd fontSize="10px" color="muted">
                        {item.hint}
                      </Kbd>
                    )}
                  </Flex>
                </Box>
              );
            })}
            {!visible.length && (
              <Text px="10px" py="16px" fontSize="12.5px" color="muted">
                没有匹配的会话或命令
              </Text>
            )}
          </Box>

          <Flex
            align="center"
            gap={3}
            px="14px"
            py="8px"
            borderTop="1px solid"
            borderColor="line"
            fontSize="10px"
            color="muted"
          >
            <Flex align="center" gap={1}>
              <Kbd fontSize="9px">↑</Kbd>
              <Kbd fontSize="9px">↓</Kbd>
              选择
            </Flex>
            <Flex align="center" gap={1}>
              <Kbd fontSize="9px">↵</Kbd>
              打开
            </Flex>
            <Flex align="center" gap={1}>
              <Kbd fontSize="9px">Esc</Kbd>
              关闭
            </Flex>
          </Flex>
        </Box>
      </Box>
    </Portal>
  );
}
