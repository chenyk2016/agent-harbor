import {
  Button,
  Drawer,
  DrawerOverlay,
  DrawerContent,
  DrawerHeader,
  DrawerCloseButton,
  DrawerBody,
  Flex,
  Td,
  Tr,
  Text,
} from "@chakra-ui/react";
import { Link, useSearchParams } from "react-router";
import type {
  AdminPageResult,
  LedgerRow,
  RequestRow,
} from "../../../../../src/shared/admin.js";
import { AdminPage, Card } from "./ui.js";
import {
  AdminFilters,
  DataTable,
  duration,
  EmptyRow,
  ExportButton,
  LoadState,
  micro,
  Pager,
  short,
  stamp,
  statusName,
  useAdminParams,
  useAdminQuery,
} from "./AdminData.js";
import { RequestEvidence } from "./RequestEvidence.js";
export function AdminActivity() {
  const [params, setParams] = useSearchParams(),
    update = useAdminParams(params, setParams),
    kind = params.get("tab") === "ledger" ? "ledger" : "requests";
  const q = new URLSearchParams(params);
  q.delete("request");
  q.delete("tab");
  q.set("limit", "50");
  const state = useAdminQuery<AdminPageResult<RequestRow | LedgerRow>>(
      "/admin/operations/" + kind + "?" + q,
    ),
    selected = params.get("request");
  return (
    <AdminPage
      title="请求与历史"
      subtitle="全量服务端搜索；默认仅展示运行和财务元数据。"
      actions={
        <Flex gap={2}>
          <Button size="sm" onClick={state.refresh}>
            刷新
          </Button>
          <ExportButton kind={kind} params={params} />
        </Flex>
      }
    >
      <Flex gap={2} mb={4}>
        <Button
          size="sm"
          variant={kind === "requests" ? "solid" : "outline"}
          onClick={() => update({ tab: "requests", state: "" })}
        >
          模型请求
        </Button>
        <Button
          size="sm"
          variant={kind === "ledger" ? "solid" : "outline"}
          onClick={() => update({ tab: "ledger", state: "" })}
        >
          人民币流水
        </Button>
      </Flex>
      <Card p={4}>
        <AdminFilters
          params={params}
          update={update}
          states={
            kind === "requests"
              ? [
                  ["reserved", "预占中"],
                  ["unknown", "待核对"],
                  ["settled", "已结算"],
                ]
              : []
          }
        />
        <LoadState
          busy={state.busy}
          error={state.error}
          retry={state.refresh}
        />
        {state.data && (
          <>
            {kind === "requests" ? (
              <DataTable
                heads={[
                  "时间 / 请求",
                  "用户 / 会话",
                  "模型 / 版本",
                  "状态 / 耗时",
                  "人民币费用",
                  "操作",
                ]}
              >
                {state.data.items.length ? (
                  state.data.items.map((item) => {
                    const r = item as RequestRow;
                    return (
                      <Tr key={r.id}>
                        <Td whiteSpace="nowrap">
                          {stamp(r.createdAt)}
                          <Text fontSize="11px">{short(r.id)}</Text>
                        </Td>
                        <Td>
                          <Link
                            to={
                              "/admin/users?user=" +
                              encodeURIComponent(r.userId)
                            }
                          >
                            {r.userName ?? r.userId}
                          </Link>
                          <Text fontSize="11px">
                            {short(r.sessionId)} · 轮次 {short(r.messageId)}
                          </Text>
                        </Td>
                        <Td>
                          {r.modelName}
                          <Text fontSize="11px">{short(r.versionId)}</Text>
                        </Td>
                        <Td>
                          {statusName(r.state)}
                          <Text fontSize="11px">{duration(r.durationMs)}</Text>
                        </Td>
                        <Td whiteSpace="nowrap">
                          已扣 {micro(r.charged)}
                          <Text fontSize="11px">
                            预占 {micro(r.reserved)} · 免收 {micro(r.waived)}
                          </Text>
                        </Td>
                        <Td>
                          <Button
                            size="xs"
                            onClick={() => update({ request: r.id })}
                          >
                            证据详情
                          </Button>
                        </Td>
                      </Tr>
                    );
                  })
                ) : (
                  <EmptyRow cols={6} />
                )}
              </DataTable>
            ) : (
              <DataTable
                heads={["时间", "用户", "类型", "金额", "变更后余额", "备注"]}
              >
                {state.data.items.length ? (
                  state.data.items.map((item) => {
                    const r = item as LedgerRow;
                    return (
                      <Tr key={r.id}>
                        <Td whiteSpace="nowrap">{stamp(r.createdAt)}</Td>
                        <Td>{r.userName ?? r.userId}</Td>
                        <Td>{r.kind}</Td>
                        <Td>{micro(r.amount)}</Td>
                        <Td>{micro(r.balanceAfter)}</Td>
                        <Td maxW="260px" whiteSpace="normal">
                          {r.note}
                        </Td>
                      </Tr>
                    );
                  })
                ) : (
                  <EmptyRow cols={6} />
                )}
              </DataTable>
            )}
            <Pager page={state.data} update={update} />
          </>
        )}
      </Card>
      <Drawer
        isOpen={!!selected}
        onClose={() => update({ request: "" })}
        placement="right"
        size="xl"
      >
        <DrawerOverlay />
        <DrawerContent>
          <DrawerCloseButton />
          <DrawerHeader>请求证据</DrawerHeader>
          <DrawerBody pb={6}>
            {selected && <RequestEvidence key={selected} id={selected} />}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </AdminPage>
  );
}
