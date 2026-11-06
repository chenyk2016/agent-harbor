/** 工作台分区导航：桌面为左侧竖栏，窄屏为内容上方的横向 chips。 */
import { useEffect, useRef } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import {
  BarChart3,
  Database,
  FolderOpen,
  GitBranch,
  ListChecks,
  Rocket,
  Settings2,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** 工作台可选分区的固定标识，供导航和内容区域保持一致。 */
export type WorkbenchSection =
  | "analysis"
  | "data"
  | "users"
  | "versions"
  | "publish"
  | "files"
  | "operations"
  | "settings";

export const workbenchSections: {
  value: WorkbenchSection;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "analysis", label: "数据分析", icon: BarChart3 },
  { value: "data", label: "数据库", icon: Database },
  { value: "users", label: "用户", icon: Users },
  { value: "versions", label: "版本记录", icon: GitBranch },
  { value: "publish", label: "发布与地址", icon: Rocket },
  { value: "files", label: "文件", icon: FolderOpen },
  { value: "operations", label: "操作记录", icon: ListChecks },
  { value: "settings", label: "设置", icon: Settings2 },
];

/** 展示工作台分区导航，用可访问的 tab 语义与键盘操作切换分区。 */
export function WorkbenchNav({
  value,
  onChange,
}: {
  value: WorkbenchSection;
  onChange: (value: WorkbenchSection) => void;
}) {
  /** 按方向键及 Home、End 在分区按钮间移动焦点并选中对应内容。 */
  const move = (event: React.KeyboardEvent<HTMLElement>) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const current = buttons.findIndex(
      (button) => button.getAttribute("aria-selected") === "true",
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : ["ArrowRight", "ArrowDown"].includes(event.key)
            ? (Math.max(current, 0) + 1) % buttons.length
            : (current - 1 + buttons.length) % buttons.length;
    const target = buttons[next];
    const nextValue = target.dataset.value as WorkbenchSection | undefined;
    if (nextValue) {
      onChange(nextValue);
      target.focus();
    }
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = ref.current?.querySelector('[aria-selected="true"]');
    if (active instanceof HTMLElement)
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);
  return (
    <Flex
      as="nav"
      ref={ref}
      aria-label="工作台导航"
      role="tablist"
      onKeyDown={move}
      direction={{ base: "row", app: "column" }}
      gap={1}
      w={{ base: "100%", app: "208px" }}
      flexShrink={0}
      px={{ base: 3, app: 2 }}
      py={{ base: 2, app: 3 }}
      bg="surface"
      borderRight={{ base: 0, app: "1px solid" }}
      borderBottom={{ base: "1px solid", app: 0 }}
      borderColor="line"
      overflowX={{ base: "auto", app: "visible" }}
      overflowY={{ app: "auto" }}
    >
      {workbenchSections.map((section) => {
        const active = section.value === value;
        const Icon = section.icon;
        return (
          <Box
            as="button"
            type="button"
            role="tab"
            key={section.value}
            data-value={section.value}
            aria-selected={active}
            display="flex"
            alignItems="center"
            gap={2}
            h="36px"
            px={2.5}
            borderRadius="8px"
            flexShrink={0}
            fontSize="12.5px"
            fontWeight={active ? 550 : 450}
            color={active ? "brand.600" : "ink2"}
            bg={active ? "brand.50" : "transparent"}
            _hover={{
              bg: active ? "brand.50" : "surfaceHover",
              color: active ? "brand.600" : "ink",
            }}
            _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
            onClick={() => onChange(section.value)}
          >
            <Icon size={16} />
            <Text whiteSpace="nowrap">{section.label}</Text>
          </Box>
        );
      })}
    </Flex>
  );
}
