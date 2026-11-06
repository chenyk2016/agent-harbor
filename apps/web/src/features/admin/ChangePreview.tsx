import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Text,
} from "@chakra-ui/react";
import type { BrowserApi } from "../../state/api.js";
import type { ChangePreview } from "../../../../../src/shared/admin.js";
import { ChangeValues } from "./AdminData.js";
export function useChangePreview(api: BrowserApi) {
  const [preview, setPreview] = useState<ChangePreview>();
  const resolver = useRef<(ok: boolean) => void>();
  useEffect(() => () => resolver.current?.(false), []);
  const requestChange = useCallback(
    async <T,>(
      path: string,
      method: string,
      input: Record<string, unknown>,
    ): Promise<T> => {
      if (resolver.current) throw new Error("请先处理当前变更预览");
      const p = await api.request<ChangePreview>(
        "/admin/operations/preview",
        "POST",
        { path, method, input },
      );
      // 售价原始快照以微元保存；预览使用与编辑表单相同的元单位。
      const before = p.before as Record<string, unknown> | null;
      const price = before?.price;
      const shown =
        price && typeof price === "object" && !Array.isArray(price)
          ? {
              ...before,
              price: Object.fromEntries(
                Object.entries(price).map(([k, v]) => [
                  k,
                  ["input", "output", "cacheRead", "cacheWrite"].includes(k) &&
                  typeof v === "number"
                    ? v / 1e6
                    : v,
                ]),
              ),
              priceUnit: "元 / 百万 Token",
            }
          : p.before;
      setPreview({ ...p, before: shown });
      const accepted = await new Promise<boolean>((resolve) => {
        resolver.current = resolve;
      });
      resolver.current = undefined;
      setPreview(undefined);
      if (!accepted) throw new Error("已取消变更");
      return api.request<T>(path, method, { ...input, previewToken: p.token });
    },
    [api],
  );
  const close = (ok: boolean) => resolver.current?.(ok);
  return {
    requestChange,
    changeDialog: (
      <Modal
        isOpen={!!preview}
        onClose={() => close(false)}
        size="xl"
        closeOnOverlayClick={false}
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>确认配置变更影响</ModalHeader>
          <ModalBody>
            {preview && (
              <Box>
                <Text mb={3}>{preview.effect}</Text>
                <Text fontSize="12px" mb={4}>
                  相关环境 {preview.affectedSessions} 个 · 活动消息{" "}
                  {preview.activeMessages} 条
                </Text>
                <ChangeValues
                  before={preview.before}
                  after={preview.requested}
                />
                <Text mt={3} fontSize="12px" color="muted">
                  若配置在预览后发生变化，提交会被拒绝，需要重新预览。
                </Text>
              </Box>
            )}
          </ModalBody>
          <ModalFooter gap={2}>
            <Button onClick={() => close(false)}>取消</Button>
            <Button colorScheme="blue" onClick={() => close(true)}>
              确认变更
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    ),
  };
}
