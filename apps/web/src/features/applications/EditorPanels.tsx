/** 工作台分区：数据库、版本、发布、操作记录、设置和文件容器。 */
import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Input,
  Link,
  Spinner,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
} from "@chakra-ui/react";
import {
  Copy,
  Download,
  RefreshCw,
  Save,
  Undo2,
} from "lucide-react";
import { Select } from "../../shared/select.js";
import { date, Hint, Pill } from "../../shared/ui.js";
import type { BrowserApi } from "../../state/api.js";
import type { Workbench } from "../../app/use-workspace.js";
import { explain } from "../../state/errors.js";
import { DeleteResourceButton } from "../deletions/DeleteResource.js";
import { Files } from "../Files.js";
import { Card, EmptyState, SectionHeader } from "./EditorChrome.js";
import {
  endpointLabel,
  operationError,
  operationKinds,
  operationTone,
  phases,
  states,
  type AppRecord,
  type Detail,
  type Endpoint,
} from "./labels.js";

/** 编辑页注入的统一操作提交函数；各面板借此复用请求编号、忙状态和刷新处理。 */
type Act = (path: string, body: Record<string, unknown>) => Promise<void>;

/** 展示源码版本历史，并发起固定版本下载、恢复或预览构建。 */
export function VersionsPanel({
  detail,
  act,
  pending,
  sourceBusy,
}: {
  detail: Detail;
  act: Act;
  pending: boolean;
  sourceBusy: boolean;
}) {
  return (
    <Box>
      <SectionHeader
        title="版本记录"
        description="一次有效修改保存为一个版本。恢复旧版本会生成新版本，不覆盖已有历史。"
        actions={
          <Button
            size="sm"
            leftIcon={<Save size={14} />}
            isDisabled={pending || sourceBusy}
            onClick={() =>
              void act("snapshots", {
                expectedHeadRevisionId: detail.app.headRevisionId,
              })
            }
          >
            保存当前版本
          </Button>
        }
      />
      {detail.revisions.length ? (
        <Card>
          {detail.revisions.map((revision) => {
            const current = revision.id === detail.app.headRevisionId;
            return (
              <Flex
                key={revision.id}
                direction={{ base: "column", sm: "row" }}
                align={{ base: "stretch", sm: "center" }}
                gap={{ base: 2, sm: 3 }}
                px={4}
                py={3}
                borderTop="1px solid"
                borderColor="line"
                _first={{ borderTop: 0 }}
                bg={current ? "brand.50" : undefined}
              >
                <HStack spacing={2} minW={0} flex={1}>
                  <Badge
                    bg={current ? "brand.100" : "sunken"}
                    color={current ? "brand.700" : "ink2"}
                    flexShrink={0}
                  >
                    v{revision.number}
                  </Badge>
                  <Text fontSize="12.5px" fontWeight={550} noOfLines={1}>
                    {revision.summary}
                  </Text>
                  {current && (
                    <Badge bg="okTint" color="ok" flexShrink={0}>
                      当前
                    </Badge>
                  )}
                </HStack>
                <Text
                  fontSize="11px"
                  color="muted"
                  fontFamily="mono"
                  flexShrink={0}
                >
                  {date(revision.createdAt)} · {revision.commit.slice(0, 8)}
                </Text>
                <HStack spacing={1} justify="flex-end" flexShrink={0}>
                  <Button
                    size="xs"
                    variant="outline"
                    leftIcon={<Undo2 size={12} />}
                    isDisabled={pending || sourceBusy || current}
                    onClick={() =>
                      void act("restore", {
                        revisionId: revision.id,
                        expectedHeadRevisionId: detail.app.headRevisionId,
                      })
                    }
                  >
                    恢复并生成新版本
                  </Button>
                  <Tooltip label="下载此版本源码">
                    <IconButton
                      as={Link}
                      href={`/api/applications/${detail.app.id}/revisions/${revision.id}/export`}
                      download
                      aria-label={`下载 v${revision.number} 源码`}
                      variant="ghost"
                      size="xs"
                      icon={<Download size={13} />}
                    />
                  </Tooltip>
                </HStack>
              </Flex>
            );
          })}
        </Card>
      ) : (
        <Card>
          <EmptyState title="还没有保存的版本" description="完成一次生成或手动保存后，这里会出现版本记录。" />
        </Card>
      )}
    </Box>
  );
}

/** 展示正式入口与部署历史，提供发布、下线和历史镜像回滚操作。 */
export function PublishPanel({
  detail,
  production,
  act,
  pending,
  productionBusy,
}: {
  detail: Detail;
  production: Endpoint;
  act: Act;
  pending: boolean;
  productionBusy: boolean;
}) {
  /** 根据部署关联的源码编号取得用户可见版本号，供发布历史展示。 */
  const version = (revisionId?: string | null) =>
    detail.revisions.find((revision) => revision.id === revisionId)?.number;
  const liveVersion = version(
    detail.deployments.find(
      (deployment) => deployment.id === production.appliedDeploymentId,
    )?.revisionId,
  );
  const published = Boolean(production.appliedDeploymentId);
  return (
    <Box>
      <SectionHeader
        title="发布与地址"
        description="线上地址固定为应用路径。发布新版本会切换访问入口，旧版本保留可回滚。"
      />
      <Card mb={4}>
        <Box px={4} py={3.5}>
          <Flex align="center" gap={2} flexWrap="wrap">
            <Pill tone={published ? (production.state === "ready" ? "teal" : "amber") : "neutral"}>
              {published ? endpointLabel(production.state) : "未发布"}
            </Pill>
            <Text fontSize="12.5px" fontWeight={550}>
              {published ? `线上版本 v${liveVersion ?? "—"}` : "还没有发布过"}
            </Text>
          </Flex>
          {published ? (
            <Link
              href={production.url}
              isExternal
              display="block"
              mt={2.5}
              fontSize="12px"
              color="brand.600"
              wordBreak="break-all"
              fontFamily="mono"
            >
              {production.url}
            </Link>
          ) : (
            <Text mt={2} fontSize="12.5px" color="muted" lineHeight={1.7}>
              在顶栏发布一个已经预览过的版本后，固定地址会出现在这里。
            </Text>
          )}
        </Box>
        {published && (
          <Flex
            px={4}
            py={2.5}
            borderTop="1px solid"
            borderColor="line"
            justify="flex-end"
            bg="surfaceHover"
          >
            <Button
              size="xs"
              variant="danger"
              isDisabled={pending || productionBusy}
              onClick={() =>
                void act("unpublish", {
                  expectedGeneration: production.generation,
                })
              }
            >
              下线应用
            </Button>
          </Flex>
        )}
      </Card>
      <Text mb={2} fontSize="11.5px" fontWeight={600} color="muted">
        发布记录
      </Text>
      <Card>
        {detail.deployments.filter(
          (deployment) => deployment.environment === "production",
        ).length ? (
          detail.deployments
            .filter((deployment) => deployment.environment === "production")
            .map((deployment) => (
              <Flex
                key={deployment.id}
                align="center"
                gap={2}
                px={4}
                py={2.5}
                borderTop="1px solid"
                borderColor="line"
                _first={{ borderTop: 0 }}
              >
                <Text fontSize="12.5px" fontWeight={550} flex={1}>
                  v{version(deployment.revisionId) ?? "—"}
                </Text>
                <Pill
                  tone={
                    deployment.observedState === "ready"
                      ? "teal"
                      : deployment.observedState === "failed"
                        ? "red"
                        : "neutral"
                  }
                >
                  {states[deployment.observedState] ??
                    endpointLabel(deployment.observedState)}
                </Pill>
                <Button
                  size="xs"
                  variant="outline"
                  isDisabled={
                    pending ||
                    productionBusy ||
                    deployment.id === production.appliedDeploymentId ||
                    !deployment.revisionId
                  }
                  onClick={() =>
                    void act("rollback", {
                      deploymentId: deployment.id,
                      expectedGeneration: production.generation,
                    })
                  }
                >
                  回滚到此发布
                </Button>
              </Flex>
            ))
        ) : (
          <EmptyState title="还没有发布记录" description="发布成功后，这里会记录版本和运行状态。" />
        )}
      </Card>
      <Hint>回滚复用原镜像，业务数据保留。代码回滚不会回滚数据库。</Hint>
    </Box>
  );
}

/** 工作台显示目标数据库真实的表结构和只读记录。 */
export function DataPanel({ api, id }: { api: BrowserApi; id: string }) {
  type TableInfo = {
    name: string;
    columns: { name: string; type: string; required: boolean; default: string | null }[];
    primaryKey: string[];
    indexes: string[];
  };
  const [environment, setEnvironment] = useState("production");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [migrations, setMigrations] = useState<{ name: string; appliedAt: string }[]>([]);
  const [table, setTable] = useState("");
  const [page, setPage] = useState<{ rows: Record<string, unknown>[]; columns: string[]; next: string | null }>();
  const [cursors, setCursors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const cursor = cursors.at(-1);
  const base = `/applications/${id}/data/${environment}`;
  const environmentLabel = environment === "preview" ? "测试" : "正式";

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true);
    setCatalogError("");
    api.request<{ tables: TableInfo[]; migrations: typeof migrations }>(base).then(result => {
      if (!alive) return;
      setTables(result.tables);
      setMigrations(result.migrations);
      setTable(current => result.tables.some(item => item.name === current)
        ? current : result.tables[0]?.name ?? "");
    }).catch(value => {
      if (alive) setCatalogError(explain(value));
    }).finally(() => {
      if (alive) setCatalogLoading(false);
    });
    return () => { alive = false; };
  }, [api, base, refresh]);

  useEffect(() => {
    if (!table) return;
    let alive = true;
    setLoading(true);
    setError("");
    setPage(undefined);
    const search = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) });
    api.request<NonNullable<typeof page>>(`${base}/${encodeURIComponent(table)}?${search}`)
      .then(result => { if (alive) setPage(result); })
      .catch(value => { if (alive) setError(explain(value)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api, base, table, cursor, refresh]);

  const selected = tables.find(item => item.name === table);
  const rows = page?.rows;
  const keys = page?.columns ?? [];
  const waitingForRecords = !!table && (loading || (!page && !error));
  /** 翻页或切换表时先清空明细，避免把上一个请求的结果短暂显示为当前数据。 */
  const clearPage = () => {
    setPage(undefined);
    setError("");
  };
  /** 把数据库单元格内容转成适合工作台展示的文本，不把对象内容解释为 HTML。 */
  const display = (value: unknown) =>
    value === null || value === undefined
      ? "—"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  return (
    <Box>
      <SectionHeader
        title="数据库"
        description="测试数据与正式数据相互独立。表结构和记录均从选中的数据库读取。"
        actions={
          <Button
            size="sm"
            variant="outline"
            leftIcon={<RefreshCw size={13} />}
            isDisabled={catalogLoading || loading}
            onClick={() => {
              setCatalogLoading(true);
              clearPage();
              setCursors([]);
              setRefresh(value => value + 1);
            }}
          >
            刷新
          </Button>
        }
      />
      <Flex gap={2} mb={3} align="center" flexWrap="wrap">
        <HStack spacing={1}>
          {[
            ["production", "正式数据"],
            ["preview", "测试数据"],
          ].map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={environment === value ? "tint" : "ghost"}
              onClick={() => {
                if (value === environment) return;
                setCatalogLoading(true);
                setTables([]); setMigrations([]); setTable("");
                clearPage();
                setCursors([]); setEnvironment(value);
              }}
            >
              {label}
            </Button>
          ))}
        </HStack>
        <Box w={{ base: "full", sm: "220px" }}>
          <Select
            ariaLabel="数据表"
            value={table}
            onChange={(value) => {
              if (value === table) return;
              clearPage();
              setTable(value);
              setCursors([]);
            }}
            options={tables.map(({ name }) => ({ value: name, label: name }))}
            disabled={!tables.length}
            compact
          />
        </Box>
      </Flex>
      {migrations.length > 0 && (
        <Box as="details" mb={3} fontSize="sm">
          <summary>已执行迁移</summary>
          {migrations.map(item => <Text key={item.name}>
            {item.name} · {new Date(item.appliedAt).toLocaleString()}
          </Text>)}
        </Box>
      )}
      {selected && (
        <Box as="details" mb={3} fontSize="sm">
          <summary>表结构</summary>
          {selected.columns.map(column => (
            <Text key={column.name}>{column.name} · {column.type}{column.required ? " · 必填" : ""}
              {selected.primaryKey.includes(column.name) ? " · 主键" : ""}
              {column.default === null ? "" : ` · 默认 ${column.default}`}</Text>
          ))}
          {selected.indexes.map(index => <Text key={index}>{index}</Text>)}
        </Box>
      )}
      <Card>
        {catalogLoading || waitingForRecords ? (
          <Flex align="center" justify="center" gap={2} py={12} role="status">
            <Spinner size="sm" />
            <Text fontSize="sm" color="muted">
              正在读取{environmentLabel}{catalogLoading ? "库的表结构" : "记录"}…
            </Text>
          </Flex>
        ) : catalogError || error ? (
          <Alert status="error" fontSize="12px" borderRadius="0">
            <AlertIcon boxSize="14px" />
            无法读取数据：{catalogError || error}
          </Alert>
        ) : !table ? (
          <EmptyState
            title={`${environmentLabel}库暂无数据表`}
            description="此环境成功部署并创建表后，即可在这里查看记录。也可以切换到另一套数据。"
          />
        ) : rows?.length ? (
          <Box overflowX="auto">
            <Table size="sm">
              <Thead>
                <Tr>
                  {keys.map((key) => (
                    <Th
                      key={key}
                      fontSize="10.5px"
                      color="muted"
                      textTransform="none"
                    >
                      {key}
                    </Th>
                  ))}
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((row, index) => (
                  <Tr key={index}>
                    {keys.map((key) => (
                      <Td key={key} fontSize="12px" color="ink2" whiteSpace="nowrap">
                        {display(row[key])}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>
        ) : (
          <EmptyState title="暂无记录" description={`${environmentLabel}库已建好 ${table} 表，目前没有记录。`} />
        )}
      </Card>
      {rows?.length ? (
        <HStack mt={2}>
          <Text fontSize="11px" color="muted">第 {cursors.length + 1} 页 · {rows.length} 条</Text>
          <Button size="xs" isDisabled={!cursors.length || loading} onClick={() => {
            clearPage();
            setCursors(value => value.slice(0, -1));
          }}>上一页</Button>
          <Button size="xs" isDisabled={!page?.next || loading}
            onClick={() => {
              if (!page?.next) return;
              const next = page.next;
              clearPage();
              setCursors(value => [...value, next]);
            }}>下一页</Button>
        </HStack>
      ) : null}
    </Box>
  );
}

/** 展示异步操作的阶段和错误，并对可取消或待核对操作提供对应入口。 */
export function OperationsPanel({
  detail,
  act,
  pending,
  onRefresh,
}: {
  detail: Detail;
  act: Act;
  pending: boolean;
  onRefresh: () => Promise<void>;
}) {
  return (
    <Box>
      <SectionHeader
        title="操作记录"
        description="生成、预览和发布都会留下记录。失败时先看原因，再决定继续修改或核对状态。"
        actions={
          <Button
            size="sm"
            variant="outline"
            leftIcon={<RefreshCw size={13} />}
            onClick={() => void onRefresh()}
          >
            刷新
          </Button>
        }
      />
      <Card>
        {detail.operations.length ? (
          detail.operations.map((operation) => (
            <Box
              key={operation.id}
              px={4}
              py={3}
              borderTop="1px solid"
              borderColor="line"
              _first={{ borderTop: 0 }}
            >
              <Flex align="center" gap={2} flexWrap="wrap">
                <Text fontSize="12.5px" fontWeight={550}>
                  {operationKinds[operation.kind] ?? operation.kind}
                </Text>
                <Pill tone={operationTone(operation.state)}>
                  {states[operation.state] ?? operation.state}
                </Pill>
                {operation.createdAt && (
                  <Text
                    ml="auto"
                    fontSize="11px"
                    color="muted"
                    fontFamily="mono"
                  >
                    {new Date(operation.createdAt).toLocaleString("zh-CN")}
                  </Text>
                )}
              </Flex>
              <Text mt={1} fontSize="12px" color="ink2">
                {phases[operation.phase] ??
                  (operation.error ? "本次操作未完成" : "状态已更新")}
              </Text>
              {operation.error && (
                <Box mt={2} px={3} py={2.5} bg="dangerTint" borderRadius="8px">
                  <Text fontSize="12px" color="dangerStrong">
                    {operationError(operation)}
                  </Text>
                  <Text mt={1} fontSize="10.5px" color="muted" fontFamily="mono">
                    参考编号：{operation.id.slice(0, 8)} · {operation.error}
                  </Text>
                </Box>
              )}
              <HStack mt={2} spacing={2} flexWrap="wrap">
                {operation.state === "reconciling" && (
                  <Button
                    size="xs"
                    variant="outline"
                    isDisabled={pending}
                    onClick={() => void act("reconcile", {})}
                  >
                    核对运行状态
                  </Button>
                )}
                {["queued", "running"].includes(operation.state) &&
                  ["preview", "publish"].includes(operation.kind) &&
                  ["accepted", "starting", "building"].includes(operation.phase) && (
                    <Button
                      size="xs"
                      variant="outline"
                      isDisabled={pending}
                      onClick={() =>
                        void act(`operations/${operation.id}/cancel`, {})
                      }
                    >
                      取消构建
                    </Button>
                  )}
              </HStack>
            </Box>
          ))
        ) : (
          <EmptyState title="还没有操作记录" description="生成、保存版本、构建预览或发布后，这里会显示过程。" />
        )}
      </Card>
    </Box>
  );
}

/** 展示应用编号和名称设置，并提供带状态版本校验的改名与资源删除入口。 */
export function SettingsPanel({
  api,
  app,
  changed,
  problem,
  notify,
  bench,
  onDeleted,
}: {
  bench: Workbench;
  onDeleted: () => void;
  api: BrowserApi;
  app: AppRecord;
  changed: () => Promise<void>;
  problem: (error: unknown) => void;
  notify: (text: string) => void;
}) {
  const [title, setTitle] = useState(app.title);
  const [saving, setSaving] = useState(false);
  useEffect(() => setTitle(app.title), [app.title, app.id]);
  /** 复制应用编号并更新复制反馈，便于定位应用或排查问题。 */
  const copyId = () => {
    void navigator.clipboard
      .writeText(app.id)
      .then(() => notify("已复制应用编号"))
      .catch(() => notify("复制未完成，请手动选择。"));
  };
  return (
    <Box>
      <SectionHeader
        title="设置"
        description="名称只影响显示，不改变固定发布地址。"
      />
      <Card p={4} mb={4}>
        <Text mb={1.5} fontSize="12.5px" fontWeight={550}>
          应用名称
        </Text>
        <Flex gap={2} flexWrap="wrap">
          <Input
            value={title}
            maxLength={120}
            bg="surface"
            onChange={(event) => setTitle(event.target.value)}
            flex={1}
            minW="220px"
          />
          <Button
            size="sm"
            alignSelf="center"
            isLoading={saving}
            isDisabled={!title.trim()}
            onClick={() => {
              setSaving(true);
              void api
                .request(`/applications/${app.id}`, "PATCH", {
                  title: title.trim(),
                  expectedStateVersion: app.stateVersion,
                })
                .then(changed)
                .catch(problem)
                .finally(() => setSaving(false));
            }}
          >
            保存名称
          </Button>
        </Flex>
      </Card>
      <Card px={4} py={3.5} mb={4}>
        <Flex align="center" gap={2} flexWrap="wrap">
          <Box flex={1} minW="200px">
            <Text fontSize="11.5px" color="muted">
              应用编号
            </Text>
            <Text fontSize="12.5px" fontFamily="mono" mt={1}>
              {app.id}
            </Text>
          </Box>
          <Button
            size="xs"
            variant="outline"
            leftIcon={<Copy size={12} />}
            onClick={copyId}
          >
            复制
          </Button>
        </Flex>
      </Card>
      <Card p={4} mt={4} mb={4}><Text fontWeight={600} mb={2}>永久删除应用</Text><Text fontSize="sm" color="muted" mb={3}>删除开发对话、源码、业务数据及专属运行资源，无法恢复。</Text><DeleteResourceButton target={{kind:"application",id:app.id,title:app.title,sessionId:app.developmentSessionId}} bench={bench} onDeleted={onDeleted}/></Card>
      <Hint>
        发布地址使用固定应用编号，修改名称不会改变地址。预览在编辑页 30 分钟未使用后自动暂停；正式应用独立运行。
      </Hint>
    </Box>
  );
}

/** 把应用关联开发会话的文件能力接到工作台，复用现有文件浏览和上传流程。 */
export function FilesPanel({ bench }: { bench: Workbench }) {
  return (
    <Box>
      <SectionHeader
        title="文件"
        description="查看和上传开发工作区的文件；修改仍通过左侧对话完成。"
      />
      <Card p={4}>
        <Files bench={bench} />
      </Card>
    </Box>
  );
}
