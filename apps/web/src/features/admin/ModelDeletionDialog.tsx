import { useEffect, useState } from "react";
import {
  Button, Modal, ModalBody, ModalCloseButton, ModalContent,
  ModalFooter, ModalHeader, ModalOverlay, Spinner, Stack, Text,
} from "@chakra-ui/react";
import { explain } from "../../state/errors.js";
import { useAdmin } from "./context.js";
import { ErrorNote } from "./ui.js";

export interface ModelDeletionTarget {
  kind: "provider" | "deployment";
  id: string;
  name: string;
}

export function ModelDeletionDialog({ target, onClose, onDeleted, onChanged }: {
  target: ModelDeletionTarget;
  onClose: () => void;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const { api, problem } = useAdmin();
  const provider = target.kind === "provider";
  const label = provider ? "供应商" : "模型";
  const path = `/admin/llm/${provider ? "providers" : "deployments"}/${target.id}`;
  const [impact, setImpact] = useState<number>();
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [attempt, checkAgain] = useState(0);

  useEffect(() => {
    const request = new AbortController();
    setChecking(true);
    void api.request<{ models?: number; sessions?: number }>(path + "/deletion-impact", "GET", undefined, request.signal)
      .then(value => {
        if (!request.signal.aborted) setImpact(provider ? value.models : value.sessions);
      })
      .catch(value => {
        if (!request.signal.aborted) { setImpact(undefined); setError(explain(value)); }
      })
      .finally(() => {
        if (!request.signal.aborted) setChecking(false);
      });
    return () => request.abort();
  }, [api, path, provider, attempt]);

  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      await api.request(path, "DELETE");
      onDeleted();
    } catch (value) {
      setError(explain(value));
      setChecking(true);
      checkAgain(current => current + 1);
      onChanged();
      problem(value);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} closeOnOverlayClick={!deleting} closeOnEsc={!deleting}>
      <ModalOverlay />
      <ModalContent mx={4}>
        <ModalHeader>删除{label}？</ModalHeader>
        <ModalCloseButton isDisabled={deleting} />
        <ModalBody>
          <Stack fontSize="12.5px">
            <Text>「{target.name}」{provider ? "保存的密钥将被清除。" : "的所有版本路由将从网关移除。"}历史账单和用量记录会保留。</Text>
            {checking ? <Spinner size="sm" aria-label="检查使用情况" /> : impact ? (
              <ErrorNote message={provider
                ? `还有 ${impact} 个模型引用该供应商（包含历史版本）。请先删除这些模型。`
                : `还有 ${impact} 个会话占用该模型。请在相关会话切换到其他模型并完成一轮，或删除不再使用的会话；仍占用的运行环境需先关闭。`} />
            ) : impact === 0 ? <Text>使用检查通过，可以删除。</Text> : null}
            {error && <ErrorNote message={error} />}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" mr={2} isDisabled={deleting} onClick={onClose}>取消</Button>
          {!checking && impact !== 0 && (
            <Button mr={2} variant="outline" onClick={() => {
              setError("");
              checkAgain(current => current + 1);
            }}>重新检查</Button>
          )}
          <Button variant="danger" isLoading={deleting} isDisabled={checking || impact !== 0}
            onClick={() => void remove()}>确认删除</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
