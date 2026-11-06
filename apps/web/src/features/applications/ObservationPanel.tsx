/** 运营数据按环境查询；切环境/卸载时忽略旧响应，缺失数据不显示为零。 */
import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Input,
  SimpleGrid,
  Spinner,
  Stack,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from "@chakra-ui/react";
import { RefreshCw } from "lucide-react";
import { Select } from "../../shared/select.js";
import type { BrowserApi } from "../../state/api.js";
import {
  Card,
  EmptyState,
  InlineNote,
  SectionHeader,
  StatTile,
} from "./EditorChrome.js";

const labels: Record<string, string> = {
  disabled: "观测未启用",
  not_instrumented: "此环境尚未接入",
  waiting: "已接入，等待数据",
  observed: "已有观测数据",
  partial: "数据超过查询上限，当前为部分数据",
  stale: "最近没有收到新数据",
};
const rowLabels: Record<string, string> = {
  pageViews: "页面浏览",
  visitors: "匿名访客",
  sessions: "访问次数",
  goals: "核心目标完成",
  edgeRequests: "网关请求（含资源）",
  apiRequests: "接口请求",
  apiFailures: "接口5xx",
  aborted: "请求中止",
  p95Ms: "接口P95（毫秒）",
  pageErrors: "页面错误",
};

/** 按应用、环境和时间范围读取业务观测汇总，展示流量、转化、质量及版本信息。 */
export function ObservationPanel({
  api,
  id,
  onDiagnose, reportId, reportSection, initialEnvironment, initialDays, onLive,
}: {
  api: BrowserApi;
  id: string;
  onDiagnose: (text: string) => void;
  reportId?: string;
  reportSection?: string;
  initialEnvironment?: string;
  initialDays?: number;
  onLive?: () => void;
}) {
  const [env, setEnv] = useState(initialEnvironment === "preview" ? "preview" : "production"),
    [days, setDays] = useState(initialDays && [1, 7, 30].includes(initialDays) ? initialDays : 7),
    [tab, setTab] = useState("overview"),
    [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<any>(),
    [error, setError] = useState("");
  const [frozen, setFrozen] = useState<{ asOf: number; from: number; environment: string; days: number }>();
  useEffect(() => {
    if (reportId && reportSection && ["overview", "funnel", "quality", "versions"].includes(reportSection)) setTab(reportSection);
  }, [reportId, reportSection]);
  const queryEnv = reportId ? undefined : env, queryDays = reportId ? undefined : days;
  useEffect(() => {
    let alive = true;
    setData(undefined);
    setFrozen(undefined);
    setError("");
    api
      .request(
        reportId ? `/applications/${id}/observability/reports/${encodeURIComponent(reportId)}`
          : `/applications/${id}/observability/summary?environment=${queryEnv}&days=${queryDays}`,
      )
      .then((value) => {
        if (alive) {
          if (reportId) {
            const snapshot = value as { asOf: number; from: number; environment: string; days: number; data: unknown };
            setFrozen(snapshot);
            setEnv(snapshot.environment);
            setDays(snapshot.days);
            setData(snapshot.data);
          } else setData(value);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(reportId && e instanceof Error && e.message.includes("REPORT_NOT_FOUND_OR_EXPIRED")
            ? "报表已过期、被清除或无权查看。可以查看当前数据。" : String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [api, id, queryEnv, queryDays, refresh, reportId]);

  return (
    <Box>
      <SectionHeader
        title="数据分析"
        description="只统计当前环境；缺失数据不显示为零。匿名访客为浏览器估计。"
      />
      {reportId && <HStack mb={4} flexWrap="wrap">
        <Text fontSize="sm">{frozen
          ? `报表快照 · ${frozen.environment === "production" ? "正式" : "测试"} · 最近 ${frozen.days} 天 · ${new Date(frozen.from).toLocaleString()} 至 ${new Date(frozen.asOf).toLocaleString()}`
          : "报表快照"}</Text>
        <Button size="xs" onClick={onLive}>查看当前数据</Button>
      </HStack>}
      {!reportId && <HStack spacing={2} mb={4} flexWrap="wrap">
        <HStack spacing={1}>
          {[
            ["production", "正式"],
            ["preview", "测试"],
          ].map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={env === value ? "tint" : "ghost"}
              onClick={() => setEnv(value)}
            >
              {label}
            </Button>
          ))}
        </HStack>
        <HStack spacing={1}>
          {[1, 7, 30].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={days === value ? "tint" : "ghost"}
              onClick={() => setDays(value)}
            >
              最近{value}天
            </Button>
          ))}
        </HStack>
        <Button
          size="sm"
          variant="outline"
          leftIcon={<RefreshCw size={13} />}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新
        </Button>
      </HStack>}

      {error && (
        <Alert status="error" fontSize="12px" borderRadius="9px" mb={4}>
          <AlertIcon boxSize="14px" />
          无法读取运营数据：{error}
        </Alert>
      )}
      {!data && !error && (
        <Flex justify="center" py={14}>
          <Spinner />
        </Flex>
      )}
      {data && (
        <Stack spacing={4}>
          {data.status !== "observed" && (
            <InlineNote
              tone={["partial", "stale"].includes(data.status) ? "warn" : "info"}
            >
              {labels[data.status] ?? data.status}
              {data.status === "disabled"
                ? "。请让管理员核对平台观测的初始化和运行状态。"
                : data.status === "not_instrumented"
                  ? "。重新部署这个环境后，新的访问和业务事件会进入统计。"
                  : ""}
            </InlineNote>
          )}
          {data.projectionTruncated && <InlineNote tone="warn">快照中的分组明细已截断。</InlineNote>}
          {data.alerts?.map((alert: any) => (
            <InlineNote key={alert.name} tone="warn">
              {alert.name}
            </InlineNote>
          ))}
          {data.activeDeploymentInstrumented === false && (
            <InlineNote tone="warn">
              当前环境运行版本尚未接入；以下可能来自历史部署。
            </InlineNote>
          )}
          {data.summary && (
            <>
              <Text fontSize="11px" color="muted" lineHeight={1.6}>
                UTC 日期统计 · 最近接收{" "}
                {data.lastReceivedAt
                  ? new Date(data.lastReceivedAt).toLocaleString()
                  : "暂无"}{" "}
                · 渠道未知不等于直接访问。
              </Text>
              <Flex
                gap={1}
                role="tablist"
                aria-label="分析视图"
                flexWrap="wrap"
              >
                {[
                  ["overview", "概览"],
                  ["funnel", "转化"],
                  ["quality", "质量"],
                  ["versions", "版本"],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    role="tab"
                    aria-selected={tab === value}
                    variant={tab === value ? "tint" : "ghost"}
                    onClick={() => setTab(value)}
                  >
                    {label}
                  </Button>
                ))}
              </Flex>

              {tab === "overview" && (
                <Stack spacing={4}>
                  <SimpleGrid columns={{ base: 2, md: 3, "2xl": 5 }} gap={3}>
                    {Object.entries(rowLabels).map(([key, label]) => (
                      <StatTile
                        key={key}
                        label={label}
                        value={data.summary[key] ?? "—"}
                      />
                    ))}
                  </SimpleGrid>
                  <Card px={4} py={3.5}>
                    <Text fontSize="11.5px" color="muted">
                      核心目标
                    </Text>
                    <Text mt={1} fontSize="12.5px">
                      {data.primaryGoal ?? "尚未配置业务目标"}
                    </Text>
                  </Card>
                  <Card>
                    <Flex px={4} pt={3.5} pb={1} justify="space-between" align="baseline">
                      <Text fontSize="13px" fontWeight={600}>
                        每日浏览（UTC）
                      </Text>
                      <Text fontSize="11px" color="muted">
                        最近 {days} 天
                      </Text>
                    </Flex>
                    <Box px={4} pb={4} pt={2}>
                      <Bars rows={data.daily} />
                    </Box>
                  </Card>
                  <SimpleGrid columns={{ base: 1, lg: 2 }} gap={3}>
                    <Counts title="来源渠道（页面浏览）" rows={data.channels} />
                    <Counts title="设备（页面浏览）" rows={data.devices} />
                    <Counts title="事件量" rows={data.events} />
                  </SimpleGrid>
                  {!data.browserEventsReceived && (
                    <InlineNote tone="warn">
                      尚未收到浏览器事件，当前流量数字不能证明 SDK 已经覆盖真实访问。
                    </InlineNote>
                  )}
                </Stack>
              )}

              {tab === "funnel" && (
                <Stack spacing={4}>
                  <Text fontSize="12.5px" color="muted" lineHeight={1.7}>
                    同一次访问、严格按顺序、声明的转化窗口；仅统计当前事件契约。服务端未关联访问的成功只计入业务总量。
                  </Text>
                  {!reportId && data.analysisConfig && (
                    <AnalysisSettings
                      api={api}
                      id={id}
                      environment={env}
                      config={data.analysisConfig}
                      changed={() => setRefresh((value) => value + 1)}
                    />
                  )}
                  {!data.funnels.length && (
                    <Card>
                      <EmptyState
                        title="应用尚未声明转化漏斗"
                        description="可在应用需求中说明核心目标与步骤。"
                      />
                    </Card>
                  )}
                  {data.funnels.map((funnel: any) => (
                    <Card key={funnel.id} px={4} py={3.5}>
                      <Text fontSize="12.5px" fontWeight={600}>
                        {funnel.id} · {funnel.windowMinutes} 分钟
                      </Text>
                      {funnel.steps.map((step: any, index: number) => (
                        <Flex
                          key={index}
                          align="center"
                          gap={2}
                          mt={index === 0 ? 2.5 : 0}
                          py={1.5}
                          borderTop={index === 0 ? 0 : "1px solid"}
                          borderColor="line"
                        >
                          <Text flex={1} fontSize="12px" color="ink2">
                            {index + 1}. {step.name}
                          </Text>
                          <Badge>{step.count}</Badge>
                          <Text fontSize="12px">
                            {step.conversion === null
                              ? "—"
                              : (step.conversion * 100).toFixed(1) + "%"}
                          </Text>
                        </Flex>
                      ))}
                      {!!funnel.ambiguous && (
                        <Text mt={1} fontSize="11px" color="muted">
                          {funnel.ambiguous} 条跨来源同时间事件无法确认顺序
                        </Text>
                      )}
                    </Card>
                  ))}
                </Stack>
              )}

              {tab === "quality" && (
                <Stack spacing={4}>
                  <SimpleGrid columns={{ base: 1, lg: 2 }} gap={3}>
                    <Counts title="接口状态码" rows={data.statuses} />
                    <Panel title="浏览器体验">
                      {data.vitals.length ? (
                        data.vitals.map((vital: any) => (
                          <Flex
                            key={vital.metric}
                            align="center"
                            gap={2}
                            px={4}
                            py={2}
                            borderTop="1px solid"
                            borderColor="line"
                            _first={{ borderTop: 0 }}
                          >
                            <Text flex={1} fontSize="12px" color="ink2">
                              {vital.metric}
                            </Text>
                            <Text fontSize="12px">
                              P75 {vital.p75 ?? "暂无"}
                            </Text>
                            <Text fontSize="11px" color="muted">
                              {vital.samples} 个样本
                            </Text>
                          </Flex>
                        ))
                      ) : (
                        <Text px={4} pb={4} fontSize="12px" color="muted">
                          暂无体验数据
                        </Text>
                      )}
                    </Panel>
                  </SimpleGrid>
                  <Panel title="页面错误（脱敏分组）">
                    {!data.errors.length && (
                      <Text px={4} pb={4} fontSize="12px" color="muted">
                        所选范围内没有收到错误事件；不代表所有访问均已覆盖。
                      </Text>
                    )}
                    {data.errors.map((item: any) => (
                      <Flex
                        key={item.name}
                        align="center"
                        gap={2}
                        px={4}
                        py={2}
                        borderTop="1px solid"
                        borderColor="line"
                        _first={{ borderTop: 0 }}
                        flexWrap="wrap"
                      >
                        <Text flex={1} minW="200px" fontSize="12px" color="ink2">
                          {item.name} · {item.count} 次
                        </Text>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            onDiagnose(
                              `请诊断应用 ${id} 的${env === "production" ? "正式" : "测试"}版本问题。最近${days}天观测到：${item.name}，共${item.count}次。请结合源码核实原因；先解释修复建议，不要自动发布。`,
                            )
                          }
                        >
                          带入修复对话
                        </Button>
                      </Flex>
                    ))}
                  </Panel>
                  <Panel title="最近资源样本">
                    {!data.resources.length && (
                      <Text px={4} pb={4} fontSize="12px" color="muted">
                        暂无容器资源样本
                      </Text>
                    )}
                    {data.resources.slice(-5).map((resource: any, index: number) => (
                      <Text
                        key={index}
                        px={4}
                        py={1.5}
                        fontSize="11px"
                        color="ink2"
                        fontFamily="mono"
                        borderTop="1px solid"
                        borderColor="line"
                        _first={{ borderTop: 0 }}
                      >
                        {new Date(resource.at).toLocaleString()} · CPU{" "}
                        {resource.cpuPercent}% · 内存{" "}
                        {(resource.memoryBytes / 1048576).toFixed(1)} MiB
                      </Text>
                    ))}
                  </Panel>
                  <Panel title="采集状态">
                    <Text px={4} pt={1} fontSize="11px" color="ink2">
                      网关日志：
                      {data.edgeLogConfigured
                        ? "已配置"
                        : "未配置，网关请求数不代表完整流量"}
                    </Text>
                    <Text px={4} py={1} fontSize="11px" color="ink2">
                      本服务启动后拒绝事件：{data.rejectedSinceRestart}
                    </Text>
                    {data.states.map((state: any) => (
                      <Text
                        key={state.key}
                        px={4}
                        py={1}
                        pb={2}
                        fontSize="11px"
                        color="muted"
                        fontFamily="mono"
                      >
                        {state.key}：{JSON.stringify(state.value)}
                      </Text>
                    ))}
                  </Panel>
                </Stack>
              )}

              {tab === "versions" && (
                <Card>
                  <Box px={4} pt={3.5} pb={3}>
                    <Text fontSize="12px" color="muted" lineHeight={1.7}>
                      同一时间范围的版本分组；流量来源可能不同，不能据此直接认定改版效果。
                    </Text>
                  </Box>
                  <Box overflowX="auto">
                    <Table size="sm">
                      <Thead>
                        <Tr>
                          <Th>源码版本</Th>
                          <Th>浏览</Th>
                          <Th>成功</Th>
                          <Th>页面错误</Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {data.versions.map((version: any) => (
                          <Tr key={version.revisionId}>
                            <Td fontFamily="mono" fontSize="11px">
                              {version.revisionId.slice(0, 12)}
                            </Td>
                            <Td>{version.pageViews}</Td>
                            <Td>{version.goals}</Td>
                            <Td>{version.errors}</Td>
                          </Tr>
                        ))}
                      </Tbody>
                    </Table>
                  </Box>
                </Card>
              )}
            </>
          )}
        </Stack>
      )}
    </Box>
  );
}

/** 把每日计数绘成相对高度柱状图；无有效数据时显示空态。 */
function Bars({ rows }: { rows: { name: string; count: number }[] }) {
  if (!rows?.length || rows.every((row) => !row.count))
    return (
      <Text py={10} textAlign="center" fontSize="12px" color="muted">
        当前时间范围内暂无数据
      </Text>
    );
  const max = Math.max(...rows.map((row) => row.count), 1);
  const step = Math.max(1, Math.ceil(rows.length / 8));
  return (
    <Flex
      align="flex-end"
      gap="2px"
      h="160px"
      pt={3}
      overflowX="auto"
      role="img"
      aria-label="每日浏览趋势"
    >
      {rows.map((row, index) => (
        <Flex
          key={row.name}
          direction="column"
          align="center"
          justify="flex-end"
          gap={1}
          flex={1}
          minW="8px"
          h="100%"
          title={`${row.name}: ${row.count}`}
        >
          <Box
            w="100%"
            maxW="28px"
            h={`${Math.max(2, (row.count / max) * 112)}px`}
            bg="brand.400"
            borderRadius="3px 3px 0 0"
            opacity={row.count ? 1 : 0.35}
          />
          <Text fontSize="11px" color="muted" whiteSpace="nowrap">
            {index % step === 0 || index === rows.length - 1
              ? row.name.slice(5)
              : ""}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}

/** 以名称和次数列表展示一种分类统计，复用统一面板和无数据提示。 */
function Counts({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; count: number }[];
}) {
  return (
    <Panel title={title}>
      {rows.length ? (
        rows.map((row) => (
          <Flex
            key={row.name}
            align="center"
            gap={3}
            px={4}
            py={2}
            borderTop="1px solid"
            borderColor="line"
            _first={{ borderTop: 0 }}
          >
            <Text flex={1} fontSize="12px" color="ink2" noOfLines={1}>
              {row.name}
            </Text>
            <Text fontSize="12px" fontWeight={550}>
              {row.count}
            </Text>
          </Flex>
        ))
      ) : (
        <Text px={4} pb={4} fontSize="12px" color="muted">
          暂无数据
        </Text>
      )}
    </Panel>
  );
}

/** 为业务观测图表提供统一的标题与卡片容器。 */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <Box px={4} pt={3.5} pb={2}>
        <Text fontSize="13px" fontWeight={600}>
          {title}
        </Text>
      </Box>
      {children}
    </Card>
  );
}

/** 编辑业务目标和转化漏斗配置，保存后通知上层重新加载观测结果。 */
function AnalysisSettings({
  api,
  id,
  environment,
  config,
  changed,
}: {
  api: BrowserApi;
  id: string;
  environment: string;
  config: any;
  changed: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [goal, setGoal] = useState(config.primaryGoal || "none"),
    [steps, setSteps] = useState<string[]>(
      config.funnels[0]?.steps ?? ["page_view"],
    ),
    [minutes, setMinutes] = useState(config.funnels[0]?.windowMinutes ?? 30),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  if (!editing)
    return (
      <Button
        size="sm"
        alignSelf="start"
        variant="outline"
        onClick={() => setEditing(true)}
      >
        设置目标与漏斗
      </Button>
    );
  return (
    <Card p={4}>
      <Stack spacing={3}>
        <Text fontSize="12.5px" fontWeight={600}>
          分析设置
        </Text>
        <Text fontSize="11px" color="muted" lineHeight={1.6}>
          只影响报表口径，不改变应用业务行为。历史设置按版本保留。
        </Text>
        <Select
          ariaLabel="核心目标"
          value={goal}
          onChange={setGoal}
          options={[
            { value: "none", label: "暂不设置核心目标" },
            ...Object.entries(config.events)
              .filter(([, event]: any) => event.source === "server")
              .map(([name]) => ({ value: name, label: name })),
          ]}
        />
        <Text fontSize="12px">漏斗顺序（点击步骤移除）</Text>
        <HStack flexWrap="wrap">
          {steps.map((step, index) => (
            <Button
              key={index}
              size="xs"
              onClick={() => setSteps(steps.filter((_, n) => n !== index))}
            >
              {index + 1}. {step} ×
            </Button>
          ))}
        </HStack>
        <Select
          ariaLabel="添加漏斗步骤"
          value="add"
          onChange={(value) => {
            if (value !== "add" && steps.length < 8) setSteps([...steps, value]);
          }}
          options={[
            { value: "add", label: "添加漏斗步骤" },
            ...["page_view", ...Object.keys(config.events)].map((name) => ({
              value: name,
              label: name,
            })),
          ]}
        />
        <Text fontSize="12px">转化窗口（分钟）</Text>
        <Input
          aria-label="转化窗口（分钟）"
          type="number"
          min={1}
          max={1440}
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
        {error && <Text color="dangerStrong" fontSize="12px">{error}</Text>}
        <HStack>
          <Button
            size="sm"
            isLoading={saving}
            isDisabled={steps.length < 2 || minutes < 1 || minutes > 1440}
            onClick={() => {
              setSaving(true);
              setError("");
              void api
                .request(
                  `/applications/${id}/observability/analysis-config`,
                  "PUT",
                  {
                    environment,
                    definitionHash: config.definitionHash,
                    expectedVersion: config.version,
                    primaryGoal: goal === "none" ? null : goal,
                    funnels: [
                      {
                        id: config.funnels[0]?.id ?? "main",
                        unit: "session",
                        windowMinutes: minutes,
                        steps,
                      },
                      ...config.funnels.slice(1),
                    ],
                  },
                )
                .then(() => {
                  setEditing(false);
                  changed();
                })
                .catch((value) => setError(String(value)))
                .finally(() => setSaving(false));
            }}
          >
            保存分析设置
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            取消
          </Button>
        </HStack>
      </Stack>
    </Card>
  );
}
