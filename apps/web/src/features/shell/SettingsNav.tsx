/** 设置二级导航；退出登录放在这一列底部，与账号设置同处。 */
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { ChartColumn, Info, KeyRound, LogOut, Sun } from "lucide-react";
import { NavLink, useLocation } from "react-router";

const items = [
  { to: "/settings/account", label: "账户与用量", icon: ChartColumn },
  { to: "/settings/keys", label: "访问密钥", icon: KeyRound },
  { to: "/settings/appearance", label: "外观", icon: Sun },
  { to: "/settings/about", label: "关于", icon: Info },
];

export function SettingsNav({ onLogout }: { onLogout: () => void }) {
  const { pathname } = useLocation();
  return (
    <Flex direction="column" h="full" minH={0} bg="surface">
      <Flex align="center" px={3} pt="14px" pb="8px">
        <Text fontSize="14.5px" fontWeight={650} letterSpacing="-.01em">
          设置
        </Text>
      </Flex>
      <Flex direction="column" gap="2px" px={2}>
        {items.map(({ to, label, icon: Icon }) => {
          const active = pathname === to;
          return (
            <Button
              key={to}
              as={NavLink}
              to={to}
              variant="ghost"
              size="sm"
              justifyContent="flex-start"
              leftIcon={<Icon size={17} />}
              h="36px"
              px="10px"
              fontSize="13.5px"
              fontWeight={active ? 550 : 450}
              color={active ? "brand.700" : "ink2"}
              bg={active ? "brand.50" : undefined}
              _hover={{ bg: active ? "brand.50" : "surfaceHover" }}
            >
              {label}
            </Button>
          );
        })}
      </Flex>
      <Box px={4} pt={4}>
        <Text fontSize="11.5px" color="muted" lineHeight={1.7}>
          账号由统一身份提供。退出登录不会取消已经提交的任务。
        </Text>
      </Box>
      <Box flex={1} />
      <Box borderTop="1px solid" borderColor="line" mx={2} py={2}>
        <Button
          variant="ghost"
          size="sm"
          w="full"
          justifyContent="flex-start"
          leftIcon={<LogOut size={16} />}
          color="muted"
          fontWeight={400}
          onClick={onLogout}
        >
          退出登录
        </Button>
      </Box>
    </Flex>
  );
}
