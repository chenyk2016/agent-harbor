/** 工作文件面板：紧凑列表 + 栏内文本预览；上传仍走现有 FileBrowser。 */
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Spinner,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import {
  ChevronLeft,
  Download,
  File,
  Folder,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Workbench } from "../app/use-workspace.js";
import { bytes, Hint } from "../shared/ui.js";

const labels = {
  preparing: "校验文件中",
  uploading: "正在上传",
  ready: "上传完成",
  unknown: "结果待确认",
  failed: "上传失败",
};

export function Files({ bench }: { bench: Workbench }) {
  const { files, work, canUpload } = bench;
  const directory = files.directory;
  const [previewing, setPreviewing] = useState(false);
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreviewing(false);
  }, [files.selectedId]);

  if (files.selectedId !== work.selectedId)
    return <Hint>正在切换工作区…</Hint>;

  return (
    <Flex direction="column" gap={3} minH={0}>
      <HStack spacing={1.5}>
        <Box
          flex={1}
          minW={0}
          h="26px"
          display="flex"
          alignItems="center"
          px={2}
          bg="sunken"
          borderRadius="6px"
          fontFamily="mono"
          fontSize="10.5px"
          color="ink2"
          overflow="hidden"
        >
          <Text noOfLines={1}>/workspace/{directory?.path}</Text>
        </Box>
        <Tooltip label="上一级">
          <IconButton
            aria-label="上一级"
            variant="ghost"
            size="sm"
            icon={<ChevronLeft size={15} />}
            isDisabled={!directory?.path}
            onClick={() =>
              void files.refresh(
                (directory?.path ?? "").split("/").slice(0, -1).join("/"),
              )
            }
          />
        </Tooltip>
        <Tooltip label="刷新">
          <IconButton
            aria-label="刷新文件"
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void files.refresh()}
          />
        </Tooltip>
        <Tooltip label="上传文件">
          <IconButton
            aria-label="上传文件"
            variant="ghost"
            size="sm"
            icon={<Upload size={14} />}
            isDisabled={!canUpload()}
            onClick={() => upload.current?.click()}
          />
        </Tooltip>
        <input
          ref={upload}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const selected = [...(event.target.files ?? [])];
            event.target.value = "";
            if (selected.length) void files.upload(selected);
          }}
        />
      </HStack>

      {previewing ? (
        <Box minH={0}>
          <HStack spacing={1.5} mb={2}>
            <IconButton
              aria-label="返回文件列表"
              variant="ghost"
              size="sm"
              icon={<ChevronLeft size={15} />}
              onClick={() => setPreviewing(false)}
            />
            <Text
              flex={1}
              minW={0}
              fontFamily="mono"
              fontSize="11px"
              fontWeight={550}
              noOfLines={1}
            >
              {files.preview?.path.split("/").at(-1) ?? "文件预览"}
            </Text>
            <IconButton
              aria-label="下载文件"
              variant="ghost"
              size="sm"
              icon={<Download size={14} />}
              isDisabled={!files.preview || files.downloading}
              onClick={() => {
                if (files.preview) void files.download(files.preview.path);
              }}
            />
          </HStack>
          {files.preview?.loading && <Spinner size="sm" />}
          {files.preview?.error && (
            <Alert status="error" borderRadius="8px" fontSize="12px">
              <AlertIcon boxSize="14px" />
              {files.preview.error}
            </Alert>
          )}
          {files.preview?.value && (
            <>
              <Box
                as="pre"
                m={0}
                p="10px"
                bg="surfaceHover"
                border="1px solid"
                borderColor="line"
                borderRadius="9px"
                maxH="calc(100dvh - 260px)"
                overflow="auto"
                fontFamily="mono"
                fontSize="10.5px"
                lineHeight={1.7}
                color="ink2"
                whiteSpace="pre-wrap"
                overflowWrap="anywhere"
              >
                {files.preview.value.text}
              </Box>
              <Text fontSize="10.5px" color="muted" mt={2}>
                UTF-8 文本
                {files.preview.value.truncated ? " · 已截取前 256 KiB" : ""}
                {" · "}只读预览
              </Text>
            </>
          )}
        </Box>
      ) : (
        <>
          {directory?.loading && (
            <HStack>
              <Spinner size="sm" />
              <Hint>正在读取目录…</Hint>
            </HStack>
          )}
          {directory?.error && (
            <Alert status="error" borderRadius="8px" fontSize="12px">
              <AlertIcon boxSize="14px" />
              {directory.error}
            </Alert>
          )}
          <Box>
            {directory?.listing?.entries.map((entry) => {
              const path = [directory.path, entry.name]
                .filter(Boolean)
                .join("/");
              return (
                <Flex
                  key={entry.name}
                  role="group"
                  align="center"
                  gap={2}
                  px={1.5}
                  py="7px"
                  borderRadius="7px"
                  _hover={{ bg: "surfaceHover" }}
                >
                  <Box
                    color={entry.kind === "directory" ? "brand.500" : "muted"}
                    flexShrink={0}
                    display="flex"
                  >
                    {entry.kind === "directory" ? (
                      <Folder size={15} />
                    ) : (
                      <File size={15} />
                    )}
                  </Box>
                  <Button
                    variant="unstyled"
                    flex={1}
                    minW={0}
                    h="auto"
                    py={0}
                    textAlign="left"
                    fontSize="12px"
                    fontWeight={400}
                    color="ink"
                    isDisabled={!["file", "directory"].includes(entry.kind)}
                    onClick={() => {
                      if (entry.kind === "directory") void files.refresh(path);
                      else {
                        void files.previewFile(path);
                        setPreviewing(true);
                      }
                    }}
                  >
                    <Text noOfLines={1} overflowWrap="anywhere">
                      {entry.name}
                    </Text>
                  </Button>
                  {entry.kind === "file" && (
                    <IconButton
                      aria-label={`下载 ${entry.name}`}
                      variant="ghost"
                      size="xs"
                      opacity={0}
                      _groupHover={{ opacity: 1 }}
                      _focusVisible={{ opacity: 1 }}
                      icon={<Download size={13} />}
                      isDisabled={files.downloading}
                      onClick={() => void files.download(path)}
                    />
                  )}
                </Flex>
              );
            })}
          </Box>
          {!directory?.loading &&
            !directory?.listing?.entries.length &&
            !directory?.error && (
              <Flex
                direction="column"
                align="center"
                py={7}
                gap={2}
                color="muted"
              >
                <Folder size={24} />
                <Text fontSize="12px">这里还没有文件</Text>
                <Text fontSize="10.5px">用上方的上传按钮或输入框附件添加。</Text>
              </Flex>
            )}
          {directory?.listing?.truncated && (
            <Hint>仅显示前 1000 项，请进入具体目录查看。</Hint>
          )}
        </>
      )}

      {!!files.currentJobs.length && (
        <Box borderTop="1px solid" borderColor="line" pt={3}>
          <Text fontSize="10.5px" fontWeight={600} color="muted" mb={2}>
            上传记录
          </Text>
          <Flex direction="column" gap={2}>
            {files.currentJobs.map((job) => (
              <Box
                key={job.id}
                p={2.5}
                border="1px solid"
                borderColor="line"
                borderRadius="8px"
                fontSize="11.5px"
              >
                <Text fontWeight={550} noOfLines={1}>
                  {job.name}
                </Text>
                <Text color="muted" fontSize="10.5px" mt="1px">
                  {bytes(job.size)} · {labels[job.status]}
                </Text>
                {job.error && (
                  <Text color="dangerStrong" fontSize="10.5px" mt={1}>
                    {job.error}
                  </Text>
                )}
                {job.status === "ready" && job.file && (
                  <Button
                    size="xs"
                    variant="link"
                    mt={1.5}
                    onClick={() =>
                      work.setDraft(
                        `${work.draft}${work.draft ? "\n" : ""}/workspace/${job.file!.path}`,
                      )
                    }
                  >
                    插入消息
                  </Button>
                )}
                {job.status === "unknown" && (
                  <Button
                    size="xs"
                    variant="link"
                    mt={1.5}
                    onClick={() => void files.checkUpload(job)}
                  >
                    核对上传结果
                  </Button>
                )}
              </Box>
            ))}
          </Flex>
        </Box>
      )}

      <Hint>
        {canUpload()
          ? "单个文件最大 20 MiB，下载最大 100 MiB。"
          : "当前不可上传，请等待任务结束并连接成功。"}
      </Hint>
    </Flex>
  );
}
