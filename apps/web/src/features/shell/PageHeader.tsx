/** 页面标题与操作区；移动端把导航入口放在标题左侧。 */
import { Box, Flex, Heading, HStack, IconButton, Text } from "@chakra-ui/react";
import { ArrowLeft, Menu } from "lucide-react";
import { useOutletContext, NavLink } from "react-router";

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  showNavigation = true,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  back?: string;
  showNavigation?: boolean;
}) {
  const { openNavigation } = useOutletContext<{ openNavigation(): void }>();
  return (
    <Flex align="flex-start" gap={3} mb="22px" flexWrap="wrap">
      {showNavigation && (
        <IconButton
          display={{ base: "inline-grid", lg: "none" }}
          aria-label="打开导航"
          variant="ghost"
          size="sm"
          icon={<Menu size={19} />}
          onClick={openNavigation}
          mt="2px"
        />
      )}
      {back && (
        <IconButton
          as={NavLink}
          to={back}
          aria-label="返回"
          variant="ghost"
          size="sm"
          icon={<ArrowLeft size={18} />}
          mt="2px"
        />
      )}
      <Box minW={0}>
        <Heading fontSize="22px" fontWeight={650} letterSpacing="-.02em">
          {title}
        </Heading>
        {subtitle && (
          <Text fontSize="13px" color="muted" mt="5px" lineHeight={1.6}>
            {subtitle}
          </Text>
        )}
      </Box>
      {actions && (
        <HStack
          spacing={2}
          ml="auto"
          mt="2px"
          flexWrap="wrap"
          justify="flex-end"
        >
          {actions}
        </HStack>
      )}
    </Flex>
  );
}
