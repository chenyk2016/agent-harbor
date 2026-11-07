/** 一级导航只保留四个去处：会话、应用、资料库、设置。 */
import {
  Avatar,
  Box,
  Flex,
  Menu,
  MenuButton,
  MenuItem,
  MenuList,
  Tooltip,
} from "@chakra-ui/react";
import {
  Anchor,
  LayoutGrid,
  Layers,
  LogOut,
  MessageSquare,
  Search,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { NavLink, useLocation } from "react-router";

function RailItem({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} placement="right" hasArrow openDelay={350}>
      <Box
        as={NavLink}
        to={to}
        aria-label={label}
        display="grid"
        placeItems="center"
        w="42px"
        h="42px"
        borderRadius="11px"
        flexShrink={0}
        color={active ? "brand.600" : "ink2"}
        bg={active ? "brand.50" : "transparent"}
        _hover={{
          bg: active ? "brand.50" : "surfaceHover",
          color: active ? "brand.600" : "ink",
        }}
        _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
      >
        {children}
      </Box>
    </Tooltip>
  );
}

export function Rail({
  userId,
  onPalette,
  onLogout,
  canManage = false,
}: {
  userId: string;
  canManage?: boolean;
  onPalette: () => void;
  onLogout: () => void;
}) {
  const { pathname } = useLocation();
  const inChat = pathname === "/" || pathname.startsWith("/sessions/");
  const inApps = pathname.startsWith("/applications");
  const inLibrary = ["/skills", "/experts", "/mcp", "/models"].some((path) =>
    pathname.startsWith(path),
  );
  const inSettings = pathname.startsWith("/settings");

  return (
    <Flex
      as="nav"
      direction="column"
      align="center"
      gap={1}
      w="64px"
      flexShrink={0}
      py="12px"
      pb="10px"
      bg="surface"
      borderRight="1px solid"
      borderColor="line"
      aria-label="主导航"
    >
      <Box
        as={NavLink}
        to="/"
        aria-label="Agent Harbor"
        display="grid"
        placeItems="center"
        w="36px"
        h="36px"
        mb="8px"
        borderRadius="11px"
        color="white"
        bgGradient="linear(to-br, #0A84FF, #00C6FB)"
        boxShadow="inset 0 1px 0 rgba(255,255,255,.18), 0 2px 6px rgba(0,113,227,.28)"
        flexShrink={0}
      >
        <Anchor size={19} strokeWidth={2} />
      </Box>
      <Box w="24px" h="1px" bg="line" my="4px" mb="6px" flexShrink={0} />

      <RailItem to="/" label="会话" active={inChat}>
        <MessageSquare size={20} />
      </RailItem>
      <RailItem to="/applications" label="应用" active={inApps}>
        <LayoutGrid size={20} />
      </RailItem>
      <RailItem to="/skills" label="资料库" active={inLibrary}>
        <Layers size={20} />
      </RailItem>

      <Tooltip label="搜索与命令 ⌘K" placement="right" hasArrow openDelay={350}>
        <Box
          as="button"
          type="button"
          aria-label="搜索与命令"
          onClick={onPalette}
          display="grid"
          placeItems="center"
          w="42px"
          h="42px"
          borderRadius="11px"
          color="ink2"
          flexShrink={0}
          _hover={{ bg: "surfaceHover", color: "ink" }}
          _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
        >
          <Search size={20} />
        </Box>
      </Tooltip>

      <Box flex={1} />
      <RailItem to="/settings/account" label="设置" active={inSettings}>
        <Settings size={20} />
      </RailItem>

      <Menu placement="right-end">
        <MenuButton
          aria-label="账号菜单"
          type="button"
          mt="4px"
          w="32px"
          h="32px"
          borderRadius="full"
          flexShrink={0}
          _hover={{ boxShadow: "0 0 0 2px var(--ah-brand-100)" }}
          _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
        >
          <Avatar
            name={userId}
            size="sm"
            w="32px"
            h="32px"
            bg="brand.50"
            color="brand.600"
            fontSize="12px"
          />
        </MenuButton>
        <MenuList fontSize="13px" minW="180px">
          <MenuItem
            as={NavLink}
            to="/settings/account"
            icon={<Settings size={15} />}
          >
            账户与设置
          </MenuItem>
          {canManage && (
            <MenuItem as={NavLink} to="/admin" icon={<ShieldCheck size={15} />}>
              管理后台
            </MenuItem>
          )}
          <MenuItem icon={<LogOut size={15} />} onClick={onLogout}>
            退出登录
          </MenuItem>
        </MenuList>
      </Menu>
    </Flex>
  );
}
