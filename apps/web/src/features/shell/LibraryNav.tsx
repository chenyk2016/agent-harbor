/** 资料库二级导航；一级导航只负责把用户带到这里。 */
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { Layers, Plug, Sparkles, Users } from "lucide-react";
import { NavLink, useLocation } from "react-router";

const items = [
  { to: "/skills", label: "技能", icon: Layers },
  { to: "/experts", label: "专家", icon: Users },
  { to: "/mcp", label: "MCP 连接", icon: Plug },
  { to: "/models", label: "模型", icon: Sparkles },
];

export function LibraryNav() {
  const { pathname } = useLocation();
  return (
    <Flex direction="column" h="full" minH={0} bg="surface">
      <Flex align="center" px={3} pt="14px" pb="8px">
        <Text fontSize="14.5px" fontWeight={650} letterSpacing="-.01em">
          资料库
        </Text>
      </Flex>
      <Flex direction="column" gap="2px" px={2}>
        {items.map(({ to, label, icon: Icon }) => {
          const active = pathname.startsWith(to);
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
          技能和专家保存方法与角色，安装后用于新会话；连接与模型由平台统一托管。
        </Text>
      </Box>
    </Flex>
  );
}
