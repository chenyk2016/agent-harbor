/** 文件编辑只负责展示与未保存提示；版本和保存事务由页面操作管理。 */
import { useState } from "react";
import {
  Box,
  Button,
  Flex,
  Input,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import type { FileItem } from "./types.js";
export function SkillFiles({
  files,
  path,
  text,
  editable,
  busy,
  select,
  change,
  add,
  remove,
}: {
  files: FileItem[];
  path: string;
  text: string;
  editable: boolean;
  busy: boolean;
  select(path: string, text: string): void;
  change(text: string): void;
  add(path: string): void;
  remove(path: string): void;
}) {
  const [newPath, setNewPath] = useState("");
  const file = files.find((file) => file.path === path);
  return (
    <Flex gap={3} direction={{ base: "column", md: "row" }}>
      <Stack w={{ base: "full", md: "210px" }} flexShrink={0}>
        {files.map((file) => (
          <Button
            key={file.path}
            size="sm"
            variant={file.path === path ? "solid" : "ghost"}
            justifyContent="flex-start"
            overflow="hidden"
            isDisabled={busy}
            onClick={() => {
              select(file.path, file.text ?? "");
            }}
          >
            {file.path}
          </Button>
        ))}
        {editable && (
          <>
            <Input
              aria-label="新增文件路径"
              placeholder="scripts/example.py"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              isDisabled={!newPath || busy}
              onClick={() => {
                add(newPath);
                setNewPath("");
              }}
            >
              添加文本文件
            </Button>
            <Button
              size="sm"
              colorScheme="red"
              variant="ghost"
              isDisabled={path === "SKILL.md" || busy}
              onClick={() => remove(path)}
            >
              删除当前文件
            </Button>
          </>
        )}
      </Stack>
      <Box flex={1} minW={0}>
        <Text mb={2} fontWeight={600}>
          {path}
        </Text>
        {file?.text === undefined ? (
          <Text color="muted">
            二进制文件或大文件，请导出源包查看，或通过 ZIP 更新。
          </Text>
        ) : (
          <Textarea
            aria-label="技能文件内容"
            value={text}
            onChange={(event) => change(event.target.value)}
            isReadOnly={!editable || busy}
            minH="440px"
            fontFamily="mono"
            fontSize="15px"
            lineHeight="1.8"
            spellCheck={false}
          />
        )}
      </Box>
    </Flex>
  );
}
