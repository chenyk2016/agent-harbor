import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertIcon,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Text,
} from "@chakra-ui/react";
import { Trash2 } from "lucide-react";
import type { Workbench } from "../../app/use-workspace.js";
import { explain } from "../../state/errors.js";
interface Target {
  kind: "session" | "application";
  id: string;
  title: string;
  sessionId?: string | null;
}
interface Job {
  id: string;
  state: "running" | "failed" | "completed";
  phase: string;
}
const phases: Record<string, string> = {
  stopping: "正在停止任务、容器并撤销访问…",
  deleting_data: "正在清除业务数据…",
  deleting_files: "正在清除文件和构建资源…",
  deleting_records: "正在清除历史记录…",
};
export function DeleteResourceDialog({
  target,
  bench,
  onClose,
  onDeleted,
}: {
  target: Target;
  bench: Workbench;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [phase, setPhase] = useState("");
  const alive = useRef(true),
    cancel = useRef(new AbortController());
  useEffect(() => {
    alive.current = true;
    cancel.current = new AbortController();
    return () => {
      alive.current = false;
      cancel.current.abort();
    };
  }, []);
  async function remove() {
    setBusy(true);
    setError(undefined);
    setPhase("stopping");
    try {
      let job = await bench.work.api.request<Job>(
        `/${target.kind === "session" ? "sessions" : "applications"}/${target.id}`,
        "DELETE",
        target.kind === "application" ? { confirmName: name } : undefined,
        cancel.current.signal,
      );
      while (alive.current && job.state === "running") {
        setPhase(job.phase);
        await new Promise((r) => setTimeout(r, 500));
        job = await bench.work.api.request<Job>(
          `/deletions/${job.id}`,
          "GET",
          undefined,
          cancel.current.signal,
        );
      }
      if (!alive.current) return;
      if (job.state !== "completed") {
        setPhase(job.phase);
        setError(
          "删除未完成，剩余资源已禁止使用。请重试删除；原内容不支持恢复。",
        );
        return;
      }
      const sid = target.kind === "session" ? target.id : target.sessionId;
      if (sid) {
        bench.work.forgetSession(sid);
        bench.files.forget(sid);
      }
      onDeleted();
    } catch (e) {
      if (alive.current) setError(explain(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal
      isOpen
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnOverlayClick={!busy}
      closeOnEsc={!busy}
      isCentered
    >
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>
          永久删除{target.kind === "session" ? "对话" : "应用"}？
        </ModalHeader>
        <ModalBody>
          <Text fontWeight={600} mb={3} overflowWrap="anywhere">
            {target.title}
          </Text>
          <Text fontSize="sm" mb={3}>
            {target.kind === "application"
              ? "预览和正式地址将立即下线，开发对话、全部源码版本、业务数据、文件及专属运行资源将一并删除。"
              : "正在执行的任务将被停止，聊天记录、上传文件、生成产物及工作环境将一并删除。"}
            删除后无法恢复。
          </Text>
          <Text fontSize="xs" color="muted" mb={3}>
            费用流水和必要审计记录保留。
          </Text>
          {target.kind === "application" && (
            <>
              <Text fontSize="sm" mb={2}>
                输入应用名称确认删除
              </Text>
              <Input
                aria-label="输入应用名称确认删除"
                value={name}
                isDisabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </>
          )}
          {busy && (
            <Text role="status" fontSize="sm" mt={3}>
              {phases[phase] ?? "正在删除…"}
            </Text>
          )}
          {error && (
            <Alert status="error" mt={3} fontSize="sm">
              <AlertIcon />
              {error}
            </Alert>
          )}
        </ModalBody>
        <ModalFooter gap={2}>
          <Button variant="ghost" onClick={onClose} isDisabled={busy}>
            {error ? "关闭" : "取消"}
          </Button>
          <Button
            colorScheme="red"
            isLoading={busy}
            loadingText="正在删除"
            isDisabled={target.kind === "application" && name !== target.title}
            onClick={() => void remove()}
          >
            {error ? "重试删除" : "永久删除"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
export function DeleteResourceButton({
  target,
  bench,
  onDeleted,
}: {
  target: Target;
  bench: Workbench;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        aria-label={`删除${target.kind === "application" ? "应用" : "对话"} ${target.title}`}
        variant="outline"
        colorScheme="red"
        leftIcon={<Trash2 size={14} />}
        onClick={() => setOpen(true)}
      >
        删除{target.kind === "application" ? "应用" : "对话"}
      </Button>
      {open && (
        <DeleteResourceDialog
          target={target}
          bench={bench}
          onClose={() => setOpen(false)}
          onDeleted={() => {
            setOpen(false);
            onDeleted();
          }}
        />
      )}
    </>
  );
}
