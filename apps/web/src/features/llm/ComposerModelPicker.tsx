import { useEffect, useState } from "react";
import { Box, Text } from "@chakra-ui/react";
import { Select } from "../../shared/select.js";
import type { ModelCatalog } from "../../../../../src/shared/llm.js";
import type { Workspace } from "../../state/workspace.js";

/** Selection changes only the next message draft, including while the current turn runs. */
export function ComposerModelPicker({ work, onValidity }: { work: Workspace; onValidity: (valid: boolean) => void }) {
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => work.api.request<ModelCatalog>("/llm/models").then(value => {
      if (alive) { setCatalog(value); setError(false); }
    }).catch(() => { if (alive) setError(true); });
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => { alive = false; clearInterval(timer); };
  }, [work.api]);
  const selected = work.modelId ?? catalog?.defaultModelId ?? "";
  const valid = catalog?.enabled === false || !!(!error && catalog?.models.some(m => m.id === selected));
  useEffect(() => { onValidity(valid); }, [valid, onValidity]);
  if (catalog?.enabled === false) return null;
  const options = catalog?.models.map(m => ({ value: m.id, label: m.name })) ?? [];
  if (!options.some(o => o.value === selected)) options.unshift({ value: selected || "__none__", label: error ? "模型列表读取失败" : selected ? "所选模型不可用" : catalog ? "暂无可用模型" : "正在读取模型…" });
  return <Box title="选择下一条消息使用的模型" maxW={{ base: "150px", sm: "200px" }} flexShrink={0}>
    <Select ariaLabel="下一条消息使用的模型" value={selected || "__none__"} onChange={id => work.setModel(id)} options={options} width="auto" maxW="100%" disabled={!catalog || error || !work.current} compact />
    {error && <Text fontSize="10px" color="dangerStrong">模型列表读取失败</Text>}
  </Box>;
}
