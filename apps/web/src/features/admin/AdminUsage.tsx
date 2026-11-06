import { Box, Button, Flex, SimpleGrid, Td, Tr, Text } from "@chakra-ui/react";
import { useSearchParams } from "react-router";
import type { UsageReport } from "../../../../../src/shared/admin.js";
import { AdminPage, Card, SectionTitle, StatTile } from "./ui.js";
import {
  AdminFilters,
  DataTable,
  duration,
  EmptyRow,
  LoadState,
  micro,
  stamp,
  useAdminParams,
  useAdminQuery,
} from "./AdminData.js";
export function AdminUsage() {
  const [params, setParams] = useSearchParams(),
    update = useAdminParams(params, setParams);
  const q = new URLSearchParams(params);
  q.delete("q");
  q.delete("state");
  const state = useAdminQuery<UsageReport>("/admin/operations/usage?" + q),
    d = state.data;
  return (
    <AdminPage
      title="用量与成本"
      subtitle="默认最近7天；按上海日期汇总。人民币扣费与美元成本分别统计。"
      actions={
        <Button size="sm" onClick={state.refresh}>
          刷新分析
        </Button>
      }
    >
      <Card p={4}>
        <AdminFilters params={params} update={update} search={false} />
        <Text fontSize="12px" color="muted">
          按用户、模型、版本及时间聚合；HTTP成功率只代表调用状态。
        </Text>
        <LoadState
          busy={state.busy}
          error={state.error}
          retry={state.refresh}
        />
      </Card>
      {d && (
        <>
          <Text my={3} fontSize="12px" color="muted">
            {stamp(d.from)} 至 {stamp(d.to)} · 读取于 {stamp(d.sampledAt)}
          </Text>
          <SimpleGrid columns={{ base: 1, md: 3 }} spacing={3}>
            <StatTile
              label="模型请求"
              value={d.rmb.requests}
              detail={
                "已结算 " +
                d.rmb.settled +
                " · 待核对 " +
                d.rmb.unknown +
                " · HTTP成功 " +
                (d.rmb.httpMeasured
                  ? ((100 * d.rmb.httpSuccess) / d.rmb.httpMeasured).toFixed(
                      1,
                    ) + "%"
                  : "未知") +
                "（有效状态样本 " +
                d.rmb.httpMeasured +
                "）"
              }
            />
            <StatTile
              label="人民币已扣"
              value={micro(d.rmb.chargedMicro)}
              detail={"在途/未知预占 " + micro(d.rmb.reservedMicro)}
            />
            <StatTile
              label="人民币免收"
              value={micro(d.rmb.waivedMicro)}
              detail={
                "实际费用未知 " +
                d.rmb.unknownActual +
                " 笔；取消未知费用另列未知"
              }
            />
            <StatTile
              label="美元已确认观察"
              value={
                d.usd.knownSpendUsd === null
                  ? "未知"
                  : "$" + d.usd.knownSpendUsd.toFixed(8)
              }
              detail={
                "记录 " + d.usd.observedRows + " · 未确认 " + d.usd.unknownRows
              }
            />
            <StatTile
              label="已记录输入 / 输出 Token"
              value={d.rmb.inputTokens + " / " + d.rmb.outputTokens}
              detail={
                "缓存读取 " +
                d.rmb.cacheReadTokens +
                " / 写入 " +
                d.rmb.cacheWriteTokens +
                "；用量不完整 " +
                d.rmb.unknownUsage +
                " 笔"
              }
            />
            <StatTile
              label="转发耗时 P50 / P95"
              value={duration(d.rmb.p50Ms) + " / " + duration(d.rmb.p95Ms)}
              detail={
                "有效计时样本 " +
                d.rmb.measured +
                "；包含转发与结算，非纯推理耗时"
              }
            />
          </SimpleGrid>
          <Card p={4} mt={4}>
            <SectionTitle
              title="每日请求与扣费"
              detail="不把请求正常结束视为回答质量通过"
            />
            <Box mt={3}>
              <DataTable heads={["日期", "请求量", "已扣人民币", "待核对"]}>
                {d.daily.length ? (
                  d.daily.map((r) => (
                    <Tr key={r.day}>
                      <Td>{r.day}</Td>
                      <Td>
                        <Flex gap={2} align="center">
                          <Box
                            w={
                              Math.max(
                                2,
                                (100 * r.requests) /
                                  Math.max(
                                    1,
                                    ...d.daily.map((x) => x.requests),
                                  ),
                              ) + "px"
                            }
                            h="7px"
                            bg="blue.400"
                            borderRadius="4px"
                          />
                          {r.requests}
                        </Flex>
                      </Td>
                      <Td>{micro(r.chargedMicro)}</Td>
                      <Td>{r.unknown}</Td>
                    </Tr>
                  ))
                ) : (
                  <EmptyRow cols={4} />
                )}
              </DataTable>
            </Box>
          </Card>
          <Card p={4} mt={4}>
            <SectionTitle title="按模型汇总" />
            <Box mt={3}>
              <DataTable
                heads={[
                  "模型 / 版本",
                  "请求 / 已记录 Token",
                  "人民币已扣",
                  "待核对",
                  "转发 P95",
                ]}
              >
                {d.models.length ? (
                  d.models.map((r, i) => (
                    <Tr key={r.modelName + ":" + i}>
                      <Td>
                        {r.modelName}
                        <Text fontSize="11px">{r.versionId}</Text>
                      </Td>
                      <Td>
                        {r.requests} / {r.tokens}
                      </Td>
                      <Td>{micro(r.chargedMicro)}</Td>
                      <Td>{r.unknown}</Td>
                      <Td>{duration(r.p95Ms)}</Td>
                    </Tr>
                  ))
                ) : (
                  <EmptyRow cols={5} />
                )}
              </DataTable>
            </Box>
          </Card>
        </>
      )}
      {d && (
        <Card p={4} mt={4}>
          <SectionTitle title="按用户汇总" />
          <Box mt={3}>
            <DataTable
              heads={["用户", "请求 / 已记录 Token", "人民币已扣", "待核对"]}
            >
              {d.users.length ? (
                d.users.map((r) => (
                  <Tr key={r.userId}>
                    <Td>{r.userName ?? r.userId}</Td>
                    <Td>
                      {r.requests} / {r.tokens}
                    </Td>
                    <Td>{micro(r.chargedMicro)}</Td>
                    <Td>{r.unknown}</Td>
                  </Tr>
                ))
              ) : (
                <EmptyRow cols={4} />
              )}
            </DataTable>
          </Box>
        </Card>
      )}
    </AdminPage>
  );
}
