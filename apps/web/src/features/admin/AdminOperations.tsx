import { useState } from "react";
import {
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Input,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Select,
  SimpleGrid,
  Td,
  Text,
  Textarea,
  Tr,
} from "@chakra-ui/react";
import { Link, useSearchParams } from "react-router";
import type {
  AdminPageResult,
  Incident,
  OperationsStatus,
  ResourceRow,
} from "../../../../../src/shared/admin.js";
import { useAdmin } from "./context.js";
import {
  AdminPage,
  Card,
  ErrorNote,
  humanBytes,
  SectionTitle,
  StatTile,
} from "./ui.js";
import {
  AdminFilters,
  DataTable,
  duration,
  EmptyRow,
  LoadState,
  Pager,
  short,
  stamp,
  statusName,
  useAdminParams,
  useAdminQuery,
} from "./AdminData.js";
import { explain } from "../../state/workspace.js";
export function AdminOperationsPage() {
  const { api, userId, problem } = useAdmin(),
    [params, setParams] = useSearchParams(),
    update = useAdminParams(params, setParams);
  const health = useAdminQuery<OperationsStatus>(
      "/admin/operations/status",
      30000,
    ),
    d = health.data;
  const q = new URLSearchParams(params);
  q.set("limit", "20");
  const resources = useAdminQuery<AdminPageResult<ResourceRow>>(
    "/admin/operations/resources?" + q,
  );
  const [selected, setSelected] = useState<Incident>(),
    [incidentStatus, setIncidentStatus] = useState("acknowledged"),
    [assignee, setAssignee] = useState(userId),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [sizes, setSizes] = useState<
    Record<
      string,
      {
        bytes?: number;
        measuredAt?: number;
        scope?: string;
        error?: string;
        busy?: boolean;
      }
    >
  >({});
  const open = (incident: Incident) => {
    setSelected(incident);
    setIncidentStatus(incident.active ? "acknowledged" : "resolved");
    setAssignee(incident.assignee ?? userId);
    setNote("");
    setError("");
  };
  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api.request(
        "/admin/operations/incidents/" + encodeURIComponent(selected.id),
        "PATCH",
        { status: incidentStatus, assignee, note },
      );
      setSelected(undefined);
      health.refresh();
    } catch (e) {
      setError(explain(e));
      problem(e);
    } finally {
      setBusy(false);
    }
  };
  const measure = async (id: string) => {
    setSizes((s) => ({ ...s, [id]: { busy: true } }));
    try {
      const result = await api.request<{
        bytes: number;
        measuredAt: number;
        scope: string;
      }>("/admin/operations/resources/" + id + "/size");
      setSizes((s) => ({ ...s, [id]: result }));
    } catch (e) {
      setSizes((s) => ({ ...s, [id]: { error: explain(e) } }));
      problem(e);
    }
  };
  return (
    <AdminPage
      title="运行状态"
      subtitle="每30秒读取状态；存活检查不调用模型。恢复事实与管理员确认分开记录。"
      actions={
        <Button
          size="sm"
          onClick={() => {
            health.refresh();
            resources.refresh();
          }}
        >
          刷新
        </Button>
      }
    >
      <LoadState
        busy={health.busy}
        error={health.error}
        retry={health.refresh}
      />
      {d && (
        <>
          <SimpleGrid columns={{ base: 1, md: 2, xl: 4 }} spacing={3}>
            {d.checks.map((c) => (
              <Card key={c.name} p={4}>
                <Text fontWeight={600}>{c.name}</Text>
                <Text
                  mt={2}
                  color={
                    c.state === "ready"
                      ? "green.600"
                      : c.state === "disabled"
                        ? "muted"
                        : "orange.600"
                  }
                >
                  {statusName(c.state)}
                </Text>
                <Text fontSize="12px" mt={2}>
                  {c.detail}
                </Text>
                <Text fontSize="11px" color="muted" mt={1}>
                  {stamp(c.checkedAt)}
                </Text>
              </Card>
            ))}
          </SimpleGrid>
          <SimpleGrid columns={{ base: 1, md: 3 }} spacing={3} mt={3}>
            <StatTile
              label="最近24小时模型请求"
              value={d.recent.requests}
              detail={
                "HTTP错误 " +
                d.recent.httpErrors +
                " · 待核对 " +
                d.recent.unknown
              }
            />
            <StatTile
              label="转发耗时 P95"
              value={duration(d.recent.p95Ms)}
              detail={"有效样本 " + d.recent.measured}
            />
            <StatTile
              label="服务进程"
              value={humanBytes(d.process.rssBytes)}
              detail={
                "运行 " +
                Math.floor(d.process.uptimeSeconds / 60) +
                " 分钟；非容器总资源"
              }
            />
          </SimpleGrid>
          <Text fontSize="12px" mt={2} color="muted">
            用量同步最近成功：
            {d.sync.enabled ? stamp(d.sync.lastSuccessAt) : "未启用"} · 采样{" "}
            {stamp(d.sampledAt)}
          </Text>
          <Card p={4} mt={4}>
            <SectionTitle
              title="站内异常处理"
              detail="认领和备注持久保存；条件仍成立时不能确认恢复。"
            />
            <Box mt={3}>
              <DataTable
                heads={["异常", "首次 / 最近发现", "状态", "负责人", "操作"]}
              >
                {d.incidents.length ? (
                  d.incidents.map((i) => (
                    <Tr key={i.id}>
                      <Td>
                        {i.title}
                        <Text fontSize="11px" wordBreak="break-all">
                          {i.target}
                        </Text>
                        {i.kind === "billing" && (
                          <Link
                            to={
                              "/admin/activity?request=" +
                              encodeURIComponent(i.target)
                            }
                          >
                            查看请求
                          </Link>
                        )}
                      </Td>
                      <Td whiteSpace="nowrap">
                        {stamp(i.firstSeenAt)}
                        <Text fontSize="11px">{stamp(i.lastSeenAt)}</Text>
                      </Td>
                      <Td>
                        {statusName(i.status)}
                        <Text fontSize="11px">
                          {i.active
                            ? "条件仍存在"
                            : i.status === "resolved"
                              ? "恢复已确认"
                              : "已检测恢复，待确认"}
                        </Text>
                      </Td>
                      <Td>
                        {i.assignee ?? "未认领"}
                        <Text fontSize="11px">{i.note}</Text>
                      </Td>
                      <Td>
                        <Button size="xs" onClick={() => open(i)}>
                          处理
                        </Button>
                      </Td>
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
      <Card p={4} mt={4}>
        <SectionTitle
          title="用户任务与执行环境"
          detail="仅元数据；文件空间需手动测量，旧记录缺少停止原因时不推测。"
        />
        <Box mt={3}>
          <AdminFilters
            params={params}
            update={update}
            dates={false}
            model={false}
            states={[
              "ready",
              "closed",
              "starting",
              "stopping",
              "reconciling",
            ].map((s) => [s, statusName(s)])}
          />
          <LoadState
            busy={resources.busy}
            error={resources.error}
            retry={resources.refresh}
          />
          {resources.data && (
            <>
              <DataTable
                heads={[
                  "用户 / 会话",
                  "环境 / 最近消息",
                  "时间",
                  "工作文件空间",
                  "历史",
                ]}
              >
                {resources.data.items.length ? (
                  resources.data.items.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <Link
                          to={
                            "/admin/users?user=" + encodeURIComponent(r.ownerId)
                          }
                        >
                          {r.userName ?? r.ownerId}
                        </Link>
                        <Text fontSize="11px">{short(r.id)}</Text>
                      </Td>
                      <Td>
                        {statusName(r.environment)}
                        <Text fontSize="11px">
                          {r.status ? statusName(r.status) : "无消息"}
                          {r.cancelRequested ? " · 已请求停止" : ""}
                          {r.stopReason ? " · " + r.stopReason : ""}
                        </Text>
                      </Td>
                      <Td whiteSpace="nowrap">
                        {stamp(r.startedAt)}
                        <Text fontSize="11px">结束 {stamp(r.finishedAt)}</Text>
                      </Td>
                      <Td>
                        <Button
                          size="xs"
                          isLoading={sizes[r.id]?.busy}
                          onClick={() => void measure(r.id)}
                        >
                          测量
                        </Button>
                        {sizes[r.id]?.bytes !== undefined && (
                          <Text fontSize="12px">
                            {humanBytes(sizes[r.id].bytes!)} ·{" "}
                            {stamp(sizes[r.id].measuredAt)}
                          </Text>
                        )}
                        {sizes[r.id]?.scope && (
                          <Text maxW="240px" fontSize="11px">
                            {sizes[r.id].scope}
                          </Text>
                        )}
                        {sizes[r.id]?.error && (
                          <Text fontSize="12px" color="red.500">
                            {sizes[r.id].error}
                          </Text>
                        )}
                      </Td>
                      <Td>
                        <Link
                          to={
                            "/admin/activity?user=" +
                            encodeURIComponent(r.ownerId) +
                            "&q=" +
                            encodeURIComponent(r.id)
                          }
                        >
                          请求记录
                        </Link>
                      </Td>
                    </Tr>
                  ))
                ) : (
                  <EmptyRow cols={5} />
                )}
              </DataTable>
              <Pager page={resources.data} update={update} />
            </>
          )}
        </Box>
      </Card>
      <Modal
        isOpen={!!selected}
        onClose={() => !busy && setSelected(undefined)}
      >
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>处理异常</ModalHeader>
          <ModalBody>
            <Text mb={3}>{selected?.title}</Text>
            <FormControl mb={3}>
              <FormLabel>处理状态</FormLabel>
              <Select
                aria-label="异常处理状态"
                value={incidentStatus}
                onChange={(e) => setIncidentStatus(e.target.value)}
              >
                <option value="open">待处理</option>
                <option value="acknowledged">已认领</option>
                <option value="resolved" disabled={selected?.active}>
                  确认恢复
                </option>
              </Select>
            </FormControl>
            <FormControl mb={3}>
              <FormLabel>负责人编号</FormLabel>
              <Input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormLabel>处理依据与备注</FormLabel>
              <Textarea
                aria-label="异常处理备注"
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
              />
            </FormControl>
            {error && <ErrorNote message={error} />}
          </ModalBody>
          <ModalFooter gap={2}>
            <Button onClick={() => setSelected(undefined)} isDisabled={busy}>
              取消
            </Button>
            <Button
              onClick={() => void save()}
              isLoading={busy}
              isDisabled={!note.trim()}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </AdminPage>
  );
}
