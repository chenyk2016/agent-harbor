import { useEffect, useState } from "react";
import { FormControl, FormLabel, Text } from "@chakra-ui/react";
import { Select } from "../../shared/select.js";
import type { BrowserApi } from "../../state/api.js";
import type { ModelCatalog } from "../../../../../src/shared/llm.js";
export function ModelPicker({
  api,
  value,
  onChange,
  compact = false,
  inline = false,
  onCatalog,
}: {
  api: BrowserApi;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  inline?: boolean;
  onCatalog?: (catalog: ModelCatalog) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    void api
      .request<ModelCatalog>("/llm/models")
      .then((v) => {
        if (alive) {
          setCatalog(v);
          onCatalog?.(v);
        }
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [api, onCatalog]);
  if (catalog && !catalog.enabled) return null;
  return (
    <FormControl>
      {!inline && <FormLabel>模型</FormLabel>}
      <Select
        ariaLabel="会话模型"
        value={value || "__default__"}
        onChange={(v) => onChange(v === "__default__" ? "" : v)}
        options={[
          {
            value: "__default__",
            label: catalog
              ? `使用默认模型${catalog.defaultModelId ? " · " + catalog.models.find((m) => m.id === catalog.defaultModelId)?.name : "（暂无可用模型）"}`
              : "正在读取模型…",
          },
          ...(catalog?.models.map((m) => ({
            value: m.id,
            label: `${m.name} · ${m.provider}`,
          })) ?? []),
        ]}
      />
      <Text
        fontSize="xs"
        color={error ? "red.600" : "muted"}
        mt={2}
        display={compact ? "none" : "block"}
      >
        {error
          ? "模型列表读取失败，请重开页面。创建时服务端会再次校验。"
          : "设置初始模型；对话输入框中可为下一条消息切换模型。"}
      </Text>
    </FormControl>
  );
}
