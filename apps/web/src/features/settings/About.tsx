/** 关于：版本与运行边界，不展示机器相关配置。 */
import { Box, Flex, Text } from "@chakra-ui/react";
import { PageHeader } from "../shell/PageHeader.js";

const rows: Array<[string, string]> = [
  ["版本", "0.9.0"],
  ["界面", "V10 · 四区工作台"],
  ["运行环境", "Docker · Claude Agent SDK"],
  ["数据保留", "会话与文件按账号隔离；关闭页面不停止任务"],
  ["模型", "平台统一托管密钥与计费"],
];

export function About() {
  return (
    <Box flex={1} minH={0} overflowY="auto">
      <Box maxW="880px" mx="auto" px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }}>
        <PageHeader
          title="关于"
          subtitle="Agent Harbor 为每个账号提供隔离的会话与工作区。"
        />
        <Box
          border="1px solid"
          borderColor="line"
          borderRadius="14px"
          bg="surface"
          px={4}
          py={1}
        >
          {rows.map(([key, value]) => (
            <Flex
              key={key}
              align="center"
              gap={4}
              py={3}
              borderBottom="1px solid"
              borderColor="line"
              _last={{ borderBottom: 0 }}
            >
              <Text fontSize="11.5px" color="muted" minW="86px">
                {key}
              </Text>
              <Text fontSize="12.5px" color="ink2" flex={1}>
                {value}
              </Text>
            </Flex>
          ))}
        </Box>
        <Text fontSize="10.5px" color="muted" mt={4} lineHeight={1.7}>
          账号由统一身份提供。退出登录不会取消已经提交的任务；管理员可以停用账号并关闭其全部工作环境。
        </Text>
      </Box>
    </Box>
  );
}
