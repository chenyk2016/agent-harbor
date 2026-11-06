/** 编辑器内统一的标题、卡片、统计块和空态；只做排版，不承载业务状态。 */
import type { ReactNode } from "react";
import {
  Box,
  Flex,
  Heading,
  HStack,
  Text,
  type BoxProps,
} from "@chakra-ui/react";

/** 工作台分区标题组件，统一标题、说明与右侧操作的排列。 */
export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <Flex align="flex-start" gap={3} mb={4} flexWrap="wrap">
      <Box flex={1} minW="200px">
        <Heading as="h2" fontSize="15px" fontWeight={650} letterSpacing="-.01em">
          {title}
        </Heading>
        {description && (
          <Text mt={1} fontSize="12.5px" color="muted" lineHeight={1.7}>
            {description}
          </Text>
        )}
      </Box>
      {actions && (
        <HStack spacing={2} flexWrap="wrap" justify="flex-end">
          {actions}
        </HStack>
      )}
    </Flex>
  );
}

/** 工作台通用卡片容器，统一背景、边框与圆角。 */
export function Card({ children, ...rest }: BoxProps) {
  return (
    <Box
      bg="surface"
      border="1px solid"
      borderColor="line"
      borderRadius="12px"
      shadow="sm"
      overflow="hidden"
      {...rest}
    >
      {children}
    </Box>
  );
}

/** 显示一项摘要指标的标签和值，供应用工作台快速浏览。 */
export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box bg="surface" border="1px solid" borderColor="line" borderRadius="12px" p={3.5}>
      <Text fontSize="11.5px" color="muted" noOfLines={1}>
        {label}
      </Text>
      <Text mt={1.5} fontSize="22px" fontWeight={650} lineHeight={1.2}>
        {value}
      </Text>
    </Box>
  );
}

/** 展示分区尚无内容时的说明与可选操作，避免只留下空白区域。 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      textAlign="center"
      px={6}
      py={10}
      maxW="420px"
      mx="auto"
    >
      {icon && (
        <Flex
          w="40px"
          h="40px"
          mb={3}
          borderRadius="12px"
          bg="brand.50"
          color="brand.600"
          align="center"
          justify="center"
        >
          {icon}
        </Flex>
      )}
      <Text fontSize="15px" fontWeight={650}>
        {title}
      </Text>
      {description && (
        <Text mt={2} fontSize="12.5px" color="muted" lineHeight={1.7}>
          {description}
        </Text>
      )}
      {action && <Box mt={4}>{action}</Box>}
    </Flex>
  );
}

/** 在分区内展示简短提示或错误信息，样式随语义色调变化。 */
export function InlineNote({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "info" | "warn";
  children: ReactNode;
}) {
  const bg = tone === "warn" ? "warnTint" : tone === "info" ? "brand.50" : "sunken";
  const color = tone === "warn" ? "warnStrong" : tone === "info" ? "brand.700" : "ink2";
  return (
    <Flex
      align="center"
      gap={2}
      px={3.5}
      py={2.5}
      bg={bg}
      color={color}
      borderRadius="9px"
      fontSize="12px"
      lineHeight={1.6}
      role="status"
    >
      {children}
    </Flex>
  );
}
