/** 外观：浅色、深色、跟随系统；偏好由根组件的 ThemeController 应用。 */
import { Box, Flex, Text, useColorMode } from "@chakra-ui/react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "../shell/PageHeader.js";
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "../../app/theme-mode.js";

const options: Array<{
  value: ThemePreference;
  label: string;
  icon: React.ReactNode;
  swatch: [string, string, string];
  split?: boolean;
}> = [
  {
    value: "light",
    label: "浅色",
    icon: <Sun size={14} />,
    swatch: ["#FBFBFC", "#FFFFFF", "#0A84FF"],
  },
  {
    value: "dark",
    label: "深色",
    icon: <Moon size={14} />,
    swatch: ["#0B0F19", "#111827", "#3B9EFF"],
  },
  {
    value: "system",
    label: "跟随系统",
    icon: <Monitor size={14} />,
    swatch: ["#FBFBFC", "#111827", "#0A84FF"],
    split: true,
  },
];

export function Appearance() {
  const { colorMode } = useColorMode();
  const [preference, setPreference] = useState<ThemePreference>(
    getThemePreference,
  );

  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box maxW="880px" mx="auto" px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }}>
        <PageHeader
          title="外观"
          subtitle="主题跟随当前设备，也可以固定为浅色或深色。"
        />

        <Text fontSize="10.5px" fontWeight={600} letterSpacing=".04em" color="muted" mb={2}>
          主题
        </Text>
        <Box
          display="grid"
          gridTemplateColumns={{ base: "1fr", md: "repeat(3, minmax(0,1fr))" }}
          gap={2.5}
        >
          {options.map((option) => {
            const selected = preference === option.value;
            return (
              <Box
                as="button"
                type="button"
                key={option.value}
                textAlign="left"
                p={3}
                borderRadius="10px"
                border="1px solid"
                borderColor={selected ? "brand.500" : "line"}
                bg="surface"
                boxShadow={selected ? "0 0 0 2px var(--ah-brand-100)" : undefined}
                _hover={{ borderColor: selected ? "brand.500" : "lineStrong" }}
                _focusVisible={{ boxShadow: "0 0 0 3px var(--ah-focus)" }}
                onClick={() => {
                  setPreference(option.value);
                  setThemePreference(option.value);
                }}
              >
                <Flex borderRadius="6px" overflow="hidden" h="40px" border="1px solid" borderColor="line">
                  {option.split ? (
                    <>
                      <Box flex={1} bg={option.swatch[0]} />
                      <Box flex={1} bg={option.swatch[1]} />
                      <Box flex={1} bgGradient="linear(to-r, #0A84FF, #3B9EFF)" />
                    </>
                  ) : (
                    option.swatch.map((color) => (
                      <Box key={color} flex={1} bg={color} />
                    ))
                  )}
                </Flex>
                <Flex align="center" gap={2} mt={2.5}>
                  <Box color={selected ? "brand.600" : "muted"}>{option.icon}</Box>
                  <Text fontSize="12px" fontWeight={600}>
                    {option.label}
                  </Text>
                  {selected && (
                    <Text ml="auto" fontSize="10px" color="brand.600">
                      当前
                    </Text>
                  )}
                </Flex>
              </Box>
            );
          })}
        </Box>

        <Box
          mt={5}
          p="16px 18px"
          border="1px solid"
          borderColor="line"
          borderRadius="14px"
          bg="surface"
        >
          <Text fontSize="13px" fontWeight={650}>
            当前渲染
          </Text>
          <Flex align="center" gap={2} mt={2} fontSize="12px" color="ink2">
            <Box w="6px" h="6px" borderRadius="full" bg="brand.500" />
            {colorMode === "dark" ? "深色" : "浅色"}
            {preference === "system" && "（跟随系统）"}
          </Flex>
          <Text fontSize="10.5px" color="muted" mt={3} lineHeight={1.6}>
            偏好只保存在这台设备的浏览器里；选择「跟随系统」时，会随设备当前的深浅色设置自动切换。
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
