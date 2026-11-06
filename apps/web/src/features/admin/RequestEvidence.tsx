import { Box, Flex, Text } from "@chakra-ui/react";
import type { RequestEvidence as Evidence } from "../../../../../src/shared/admin.js";
import { Card, SectionTitle } from "./ui.js";
import {
  duration,
  JsonValue,
  LoadState,
  micro,
  short,
  stamp,
  statusName,
  useAdminQuery,
} from "./AdminData.js";
export function RequestEvidence({ id }: { id: string }) {
  const state = useAdminQuery<Evidence>(
    "/admin/operations/requests/" + encodeURIComponent(id),
  );
  const d = state.data;
  return (
    <Box>
      <LoadState busy={state.busy} error={state.error} retry={state.refresh} />
      {d && (
        <Flex direction="column" gap={3}>
          {d.tracing && (
            <Card p={3}>
              <SectionTitle title="模型追踪" />
              <Text mt={2} fontSize="12px">
                {(
                  {
                    disabled: "未配置，观测关闭",
                    invalid: "配置不完整或无效，观测关闭",
                    historical: "此历史请求没有追踪",
                    pending: "等待上报",
                    submitted: "已提交；尚未核实云端模型记录",
                    confirmed: "已核实云端模型记录",
                    degraded: "观测上报异常，任务与账务独立运行",
                  } as Record<string, string>
                )[d.tracing.status] ?? "观测状态待核实"}
              </Text>
              {d.tracing.contentMode && (
                <Text fontSize="12px">
                  当前上报范围{" "}
                  {d.tracing.contentMode === "redacted"
                    ? "指标与脱敏正文"
                    : "仅指标"}
                </Text>
              )}
              {d.tracing.issues.length > 0 && (
                <Text fontSize="12px">
                  需检查：{d.tracing.issues.join("、")}
                </Text>
              )}
              {d.tracing.url && (
                <Text mt={2} fontSize="12px">
                  <a href={d.tracing.url} target="_blank" rel="noreferrer">
                    在 Langfuse 查看追踪 ↗
                  </a>
                </Text>
              )}
              {d.tracing.taskUrl && (
                <Text mt={2} fontSize="12px">
                  <a href={d.tracing.taskUrl} target="_blank" rel="noreferrer">
                    查看关联任务与工具 ↗
                  </a>
                </Text>
              )}
            </Card>
          )}
          <Card p={3}>
            <SectionTitle title="请求事实" detail={id} />
            <Text mt={2}>
              {d.request.modelName} · {statusName(d.request.state)}
            </Text>
            <Text fontSize="12px">
              开始 {stamp(d.request.createdAt)} · 完成{" "}
              {stamp(d.request.finishedAt)} · 转发耗时{" "}
              {duration(d.request.durationMs)}
            </Text>
            <Text fontSize="12px">
              预占 {micro(d.request.reserved)} · 已扣 {micro(d.request.charged)}{" "}
              · 平台免收 {micro(d.request.waived)}
            </Text>
            <Text fontSize="12px">
              上游状态 {d.request.httpStatus ?? "未记录"} · 原因{" "}
              {d.request.failureCode ?? d.request.note ?? "未记录"}
            </Text>
            <Text fontSize="12px" wordBreak="break-all">
              模型版本 {d.request.versionId} · 价格版本{" "}
              {d.request.priceVersionId} · 网关编号{" "}
              {d.request.gatewayCallId ?? "未知"}
            </Text>
          </Card>
          <Card p={3}>
            <SectionTitle
              title="价格快照"
              detail="人民币微元 / 百万Token；按该请求固定版本结算"
            />
            <JsonValue value={d.request.price} />
          </Card>
          <Card p={3}>
            <SectionTitle
              title="网关观察"
              detail="美元成本与人民币扣费独立；无记录不代表无消费"
            />
            {d.gateway.length ? (
              d.gateway.map((g) => (
                <Box
                  key={g.id}
                  borderBottom="1px solid"
                  borderColor="line"
                  py={2}
                >
                  <Text fontSize="12px">
                    {g.model} · {g.status} ·{" "}
                    {g.pricingKnown && g.spendUsd !== null
                      ? "$" + g.spendUsd.toFixed(8)
                      : "成本未确认"}
                  </Text>
                  <Text fontSize="11px" wordBreak="break-all">
                    上游请求 {g.requestId ?? "未知"} · {stamp(g.startedAt)}
                  </Text>
                  <JsonValue
                    value={{ usage: g.usage, cost: g.costBreakdown }}
                  />
                </Box>
              ))
            ) : (
              <Text fontSize="12px" mt={2}>
                尚无匹配记录，请检查费用同步状态。
              </Text>
            )}
          </Card>
          <Card p={3}>
            <SectionTitle title="对话与执行事件" detail={d.association} />
            {d.turns.map((t) => (
              <Text key={t.id} fontSize="12px" mt={2}>
                轮次 {short(t.id)} · {statusName(t.status)} ·{" "}
                {stamp(t.startedAt)} → {stamp(t.finishedAt)}
                {t.cancelRequested ? " · 已请求停止" : ""}
              </Text>
            ))}
            {d.events.map((e) => (
              <Box key={e.eventId} mt={2} p={2} bg="sunken" borderRadius="6px">
                <Text fontSize="12px">
                  {e.type} · 轮次 {short(e.messageId)}
                </Text>
                <JsonValue value={e.payload} />
              </Box>
            ))}
            {!d.events.length && (
              <Text fontSize="12px" mt={2}>
                没有可展示的结构化事件；历史工具记录可能只有调用开始。
              </Text>
            )}
            {d.partial && (
              <Text color="orange.600">
                当前仅显示部分证据，请按轮次缩小范围。
              </Text>
            )}
          </Card>
        </Flex>
      )}
    </Box>
  );
}
