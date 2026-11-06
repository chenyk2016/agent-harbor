/** 右栏工作区：概览、文件、动态共用同一个会话状态。 */
import { Box, Flex, IconButton, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { useEffect } from "react";
import type { Workbench } from "../../app/use-workspace.js";
import { Files } from "../Files.js";
import { Activity } from "./Activity.js";
import { Overview } from "./Overview.js";

export type WorkspaceTab = "overview" | "files" | "log";

const tabs: Array<[WorkspaceTab, string]> = [
  ["overview", "概览"],
  ["files", "文件"],
  ["log", "动态"],
];

export function WorkspacePanel({
  bench,
  tab,
  setTab,
  closeEnvironment,
  onClose,
}: {
  bench: Workbench;
  tab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
  closeEnvironment: () => void;
  onClose?: () => void;
}) {
  const state = bench.work.current;
  useEffect(() => {
    // 文件面板沿用原有 FileBrowser 的打开/刷新生命周期。
    bench.files.show(tab === "files");
  }, [bench, tab]);
  return (
    <Flex direction="column" h="full" minH={0} bg="surface">
      <Box px={3} pt={3} flexShrink={0}>
        <Flex align="center" gap={1}>
          <Text fontSize="13px" fontWeight={650}>
            工作区
          </Text>
          {onClose && (
            <IconButton
              aria-label="收起工作区"
              variant="ghost"
              size="sm"
              icon={<X size={15} />}
              ml="auto"
              onClick={onClose}
            />
          )}
        </Flex>
        <Flex
          gap="2px"
          mt={2}
          px="2px"
          borderBottom="1px solid"
          borderColor="line"
        >
          {tabs.map(([value, label]) => (
            <Box
              as="button"
              key={value}
              type="button"
              px="9px"
              py="8px"
              mb="-1px"
              fontSize="12px"
              fontWeight={tab === value ? 550 : 400}
              color={tab === value ? "ink" : "muted"}
              borderBottom="2px solid"
              borderColor={tab === value ? "brand.500" : "transparent"}
              _hover={{ color: tab === value ? "ink" : "ink2" }}
              onClick={() => setTab(value)}
            >
              {label}
            </Box>
          ))}
        </Flex>
      </Box>

      <Box flex={1} minH={0} overflowY="auto" px="14px" py="14px">
        {!state ? (
          <Text fontSize="12px" color="muted">
            选择会话后查看工作区。
          </Text>
        ) : tab === "overview" ? (
          <Overview bench={bench} closeEnvironment={closeEnvironment} />
        ) : tab === "files" ? (
          <Files bench={bench} />
        ) : (
          <Activity state={state} />
        )}
      </Box>
    </Flex>
  );
}
