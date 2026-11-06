import { useEffect, useState } from "react";
import { Button, HStack, Text } from "@chakra-ui/react";
import type { BrowserApi } from "../../state/api.js";
export function ModelUsage({
  api,
  sessionId,
  revision,
}: {
  api: BrowserApi;
  sessionId: string;
  revision?: string;
}) {
  const [value, setValue] = useState<{
      knownUsd: number;
      complete: boolean;
      pricingKnown: boolean;
      credentials: number;
      syncDelayed?: boolean;
    }>(),
    [failed, setFailed] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setValue(undefined);
    setFailed(false);
    void api
      .request<{
        knownUsd: number;
        complete: boolean;
        pricingKnown: boolean;
        credentials: number;
        syncDelayed?: boolean;
      }>(`/sessions/${sessionId}/llm-usage`)
      .then((v) => {
        if (alive) setValue(v);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [api, sessionId, revision, refresh]);
  return (
    <HStack fontSize="xs" color="muted">
      <Text>
        {value
          ? value.credentials === 0
            ? "尚未调用网关"
            : !value.pricingKnown
              ? "计价未配置或待核实，费用未知"
              : value.complete
                ? `网关观测费用 $${value.knownUsd.toFixed(6)}`
                : `已知费用 $${value.knownUsd.toFixed(6)}，部分待同步`
          : failed
            ? "费用暂不可用"
            : "读取费用…"}
      </Text>
      {value?.syncDelayed && <Text>用量同步中</Text>}
      <Button variant="link" size="xs" onClick={() => setRefresh((v) => v + 1)}>
        刷新
      </Button>
    </HStack>
  );
}
