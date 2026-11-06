import { Box, Button, Td, Tr, Text } from "@chakra-ui/react";
import { useSearchParams } from "react-router";
import type {
  AdminPageResult,
  AuditRow,
} from "../../../../../src/shared/admin.js";
import { AdminPage, Card } from "./ui.js";
import {
  AdminFilters,
  ChangeValues,
  DataTable,
  EmptyRow,
  ExportButton,
  JsonValue,
  LoadState,
  Pager,
  stamp,
  statusName,
  useAdminParams,
  useAdminQuery,
} from "./AdminData.js";
export function AdminAudit() {
  const [params, setParams] = useSearchParams(),
    update = useAdminParams(params, setParams),
    q = new URLSearchParams(params);
  q.set("limit", "50");
  const state = useAdminQuery<AdminPageResult<AuditRow>>(
    "/admin/operations/audit?" + q,
  );
  return (
    <AdminPage
      title="管理审计"
      subtitle="写操作先保存意图；结果未确认可能已生效，需核对目标状态，不能直接重做。"
      actions={<ExportButton kind="audit" params={params} />}
    >
      <Card p={4}>
        <AdminFilters
          params={params}
          update={update}
          model={false}
          states={[
            ["succeeded", "成功"],
            ["failed", "失败"],
            ["unconfirmed", "结果未确认"],
            ["legacy_recorded", "历史变更"],
          ]}
        />
        <Text fontSize="12px" mb={3}>
          用户编号筛选在本页指操作人。历史模型记录与新操作记录标记不同来源。
        </Text>
        <LoadState
          busy={state.busy}
          error={state.error}
          retry={state.refresh}
        />
        {state.data && (
          <>
            <DataTable
              heads={["时间", "操作人", "动作 / 目标", "结果", "变更详情"]}
            >
              {state.data.items.length ? (
                state.data.items.map((r) => (
                  <Tr key={r.source + ":" + r.id}>
                    <Td whiteSpace="nowrap">{stamp(r.createdAt)}</Td>
                    <Td>{r.actor}</Td>
                    <Td wordBreak="break-all">
                      {r.action}
                      <Text fontSize="11px">{r.target}</Text>
                    </Td>
                    <Td>
                      {statusName(r.outcome)}
                      <Text fontSize="11px">
                        {r.source === "model_history"
                          ? "历史模型记录"
                          : "管理操作"}
                      </Text>
                    </Td>
                    <Td minW="260px">
                      <Box as="details">
                        <Box as="summary" cursor="pointer" fontSize="12px">
                          查看前后值
                        </Box>
                        <ChangeValues before={r.before} after={r.requested} />
                        <Text fontSize="12px" mt={2}>
                          操作响应摘要
                        </Text>
                        <JsonValue value={r.result} />
                      </Box>
                    </Td>
                  </Tr>
                ))
              ) : (
                <EmptyRow cols={5} />
              )}
            </DataTable>
            <Pager page={state.data} update={update} />
          </>
        )}
        <Button mt={3} size="sm" onClick={state.refresh}>
          刷新
        </Button>
      </Card>
    </AdminPage>
  );
}
