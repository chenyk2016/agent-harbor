/** 新建与导入确认后直接生成版本；安装启用由用户单独操作。 */
import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Select } from "../../shared/select.js";
import type { Skill, ImportPreview } from "./types.js";
export function NewSkillDialog({
  open,
  busy,
  error,
  close,
  create,
}: {
  open: boolean;
  busy: boolean;
  error?: string;
  close(): void;
  create(input: { name: string; slug: string; description: string }): void;
}) {
  const [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [description, setDescription] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setSlug("");
      setDescription("");
    }
  }, [open]);
  return (
    <Modal isOpen={open} onClose={() => !busy && close()}>
      <ModalOverlay />
      <ModalContent mx={4}>
        <ModalHeader>新建技能</ModalHeader>
        <ModalCloseButton isDisabled={busy} />
        <ModalBody>
          <Stack spacing={4}>
            {error && (
              <Alert status="error">
                <AlertIcon />
                {error}
              </Alert>
            )}
            <FormControl>
              <FormLabel>显示名称</FormLabel>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="表格摘要"
              />
            </FormControl>
            <FormControl>
              <FormLabel>英文标识</FormLabel>
              <Input
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="table-summary"
              />
            </FormControl>
            <FormControl>
              <FormLabel>什么时候使用</FormLabel>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="检查用户提供的表格并生成摘要"
              />
            </FormControl>
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            isLoading={busy}
            isDisabled={!name || !slug || !description}
            onClick={() => create({ name, slug, description })}
          >
            保存技能
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
export function ImportSkillDialog({
  preview,
  skills,
  busy,
  error,
  close,
  apply,
}: {
  preview?: ImportPreview;
  skills: Skill[];
  busy: boolean;
  error?: string;
  close(): void;
  apply(target: string): void;
}) {
  const [target, setTarget] = useState("");
  useEffect(() => setTarget(""), [preview?.id]);
  return (
    <Modal isOpen={!!preview} onClose={() => !busy && close()}>
      <ModalOverlay />
      <ModalContent mx={4}>
        <ModalHeader>导入技能</ModalHeader>
        <ModalCloseButton isDisabled={busy} />
        <ModalBody>
          <Stack spacing={3}>
            {error && (
              <Alert status="error">
                <AlertIcon />
                {error}
              </Alert>
            )}
            <Text>{preview?.report.manifest?.name ?? "技能包"}</Text>
            {preview?.report.errors.map((issue, index) => (
              <Alert key={index} status="error">
                <AlertIcon />
                {issue.message}
              </Alert>
            ))}
            {preview?.report.warnings.map((issue, index) => (
              <Text key={index} color="orange.700">
                {issue.message}
              </Text>
            ))}
            <Box maxH="200px" overflowY="auto">
              {preview?.report.manifest?.files.map((path) => (
                <Text key={path} fontFamily="mono" fontSize="sm">
                  {path}
                </Text>
              ))}
            </Box>
            <Select
              ariaLabel="导入目标"
              value={target || "__new__"}
              onChange={(next) => setTarget(next === "__new__" ? "" : next)}
              options={[
                { value: "__new__", label: "创建新的个人技能" },
                ...skills
                  .filter((skill) => skill.source === "private")
                  .map((skill) => ({
                    value: skill.id,
                    label: `保存为新版本：${skill.displayName}`,
                  })),
              ]}
            />
            <Text fontSize="sm" color="muted">
              导入后直接生成版本。点击安装并启用后用于新会话。
            </Text>
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            isLoading={busy}
            isDisabled={!preview?.report.ok}
            onClick={() => apply(target)}
          >
            保存技能
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
