/** 管理后台共享的页面容器、卡片、空态和状态映射。 */
import type { ReactNode } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  HStack,
  Text,
  type BoxProps,
} from "@chakra-ui/react";
import { PageHeader } from "../shell/PageHeader.js";
import { Pill, type Tone } from "../../shared/ui.js";
import { money } from "../wallet/WalletPanel.js";

export function AdminPage({
  title,
  subtitle,
  actions,
  error,
  onRetry,
  fill = false,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  error?: string;
  onRetry?: () => void;
  fill?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      flex={1}
      minH={0}
      minW={0}
      display="flex"
      flexDirection="column"
      overflowY={fill ? "hidden" : "auto"}
    >
      <Box
        w="100%"
        maxW="1280px"
        mx="auto"
        px={{ base: 4, md: 6, lg: 8 }}
        py={{ base: 5, md: 7 }}
        flex={fill ? 1 : undefined}
        minH={fill ? 0 : undefined}
        display={fill ? "flex" : undefined}
        flexDirection={fill ? "column" : undefined}
      >
        <PageHeader title={title} subtitle={subtitle} actions={actions} />
        {error && (
          <Alert status="error" fontSize="13px" borderRadius="10px" mb={4} flexShrink={0}>
            <AlertIcon boxSize="15px" />
            <Box flex={1}>{error}</Box>
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                重试
              </Button>
            )}
          </Alert>
        )}
        {children}
      </Box>
    </Box>
  );
}

export function Card({ children, ...rest }: BoxProps) {
  return (
    <Box
      bg="surface"
      border="1px solid"
      borderColor="line"
      borderRadius="12px"
      shadow="sm"
      {...rest}
    >
      {children}
    </Box>
  );
}

export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <Card p={4}>
      <Text fontSize="11.5px" color="muted" noOfLines={1}>
        {label}
      </Text>
      <Text mt={1.5} fontSize="24px" fontWeight={650} lineHeight={1.2}>
        {value}
      </Text>
      {detail && (
        <Text mt={1.5} fontSize="11px" color="muted" lineHeight={1.6}>
          {detail}
        </Text>
      )}
    </Card>
  );
}

export function SectionTitle({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <Flex align="flex-start" gap={3} mb={2.5} flexWrap="wrap">
      <Box flex={1} minW="160px">
        <Text fontSize="13.5px" fontWeight={650}>
          {title}
        </Text>
        {detail && (
          <Text mt={1} fontSize="11.5px" color="muted" lineHeight={1.6}>
            {detail}
          </Text>
        )}
      </Box>
      {children}
    </Flex>
  );
}

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
    <Flex direction="column" align="center" justify="center" textAlign="center" px={6} py={10}>
      {icon && <Box color="muted" mb={3}>{icon}</Box>}
      <Text fontSize="13.5px" fontWeight={600}>
        {title}
      </Text>
      {description && (
        <Text mt={1.5} fontSize="12px" color="muted" lineHeight={1.7} maxW="420px">
          {description}
        </Text>
      )}
      {action && <Box mt={4}>{action}</Box>}
    </Flex>
  );
}

export function ErrorNote({
  message,
  onRetry,
  tone = "error",
}: {
  message: string;
  onRetry?: () => void;
  tone?: "error" | "warning";
}) {
  return (
    <Flex
      align="center"
      gap={2}
      px={3.5}
      py={2.5}
      bg={tone === "warning" ? "warnTint" : "dangerTint"}
      color={tone === "warning" ? "warnStrong" : "dangerStrong"}
      borderRadius="9px"
      fontSize="12px"
      role={tone === "warning" ? "status" : "alert"}
    >
      <Text flex={1}>{message}</Text>
      {onRetry && (
        <Button size="xs" variant="outline" onClick={onRetry}>
          重试
        </Button>
      )}
    </Flex>
  );
}

export function RefreshMeta({ at, onRefresh }: { at?: number; onRefresh?: () => void }) {
  return (
    <HStack spacing={2} fontSize="11px" color="muted" flexWrap="wrap">
      {at && <Text>读取于 {new Date(at).toLocaleString("zh-CN")}</Text>}
      {onRefresh && (
        <Button size="xs" variant="ghost" onClick={onRefresh}>
          刷新
        </Button>
      )}
    </HStack>
  );
}

export function UserStatus({ disabled }: { disabled: number | boolean }) {
  return (
    <Pill tone={disabled ? "red" : "teal"}>{disabled ? "已停用" : "正常"}</Pill>
  );
}

export function ModelState({ state }: { state: string }) {
  return (
    <Pill tone={state === "ready" ? "teal" : "amber"}>
      {state === "ready" ? "已同步" : "同步待确认"}
    </Pill>
  );
}

export function age(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function requestAgeTone(timestamp: number): Tone {
  return Date.now() - timestamp > 24 * 3600_000 ? "amber" : "neutral";
}

export function priceText(price: { input: number; output: number } | null) {
  return price
    ? `${money(price.input)} / ${money(price.output)}`
    : "未定价";
}

export function bytesToInput(bytes: number) {
  if (bytes >= 1024 ** 3) return { value: bytes / 1024 ** 3, unit: "GiB" as const };
  return { value: bytes / 1024 ** 2, unit: "MiB" as const };
}

export function inputToBytes(value: number, unit: "MiB" | "GiB") {
  return Math.round(value * (unit === "GiB" ? 1024 ** 3 : 1024 ** 2));
}

export function humanBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${bytes} B`;
}
