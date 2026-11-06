import { useEffect, useState } from "react";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Grid,
  Stack,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from "@chakra-ui/react";
import type { BrowserApi } from "../../state/api.js";
import { explain } from "../../state/workspace.js";
export const money = (n: number) =>
  `¥${(n / 1000000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
export interface WalletData {
  enabled?: boolean;
  balance: number;
  available: number;
  reserved: number;
  credited: number;
  spent: number;
  monthSpent: number;
  plusUntil: number | null;
  ledger: {
    id: string;
    kind: string;
    note: string;
    amount: number;
    balanceAfter: number;
    createdAt: number;
  }[];
  tokens: {
    settledCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  requests: {
    id: string;
    modelName: string;
    sessionId?: string;
    note?: string;
    reserved: number;
    state: string;
    charged: number | null;
    waived: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    createdAt: number;
  }[];
}

function requestState(state: string) {
  return state === "settled"
    ? "已结算"
    : state === "unknown"
      ? "待管理员核对"
      : "调用中";
}

/** 余额、预占和 Token 摘要；用户端和管理员详情共用。 */
export function WalletSummary({ data }: { data: WalletData }) {
  const now = Date.now();
  const held = data.requests.filter(
    (request) => request.state === "reserved" || request.state === "unknown",
  );
  return (
    <Stack spacing={3}>
      <Text fontSize="12.5px">
        {data.plusUntil && data.plusUntil > now
          ? `Plus · 到期 ${new Date(data.plusUntil).toLocaleString("zh-CN")}`
          : "普通用户"}
      </Text>
      {data.reserved > 0 && (
        <Alert
          status="warning"
          borderRadius="10px"
          alignItems="flex-start"
          fontSize="12.5px"
        >
          <AlertIcon />
          <Box>
            <Text fontWeight={600}>
              {held.some((request) => request.state === "unknown")
                ? "有费用待核对，新请求暂不可用"
                : "模型请求进行中，部分额度暂被预占"}
            </Text>
            <Text mt={1}>
              预占 {money(data.reserved)} 尚未计入扣费。账户余额为{" "}
              {money(data.balance)}，结算后释放剩余额度。
            </Text>
            {held.some((request) => request.state === "unknown") && (
              <Text mt={1}>
                请联系管理员并提供下方请求编号，核对完成后恢复使用。
              </Text>
            )}
          </Box>
        </Alert>
      )}
      <Grid templateColumns={{ base: "repeat(2,minmax(0,1fr))", md: "repeat(5,minmax(0,1fr))" }} gap={2.5}>
        {[
          ["可用余额", data.available],
          ["预占额度", data.reserved],
          ["累计获得", data.credited],
          ["累计消耗", data.spent],
          ["本月消耗", data.monthSpent],
        ].map(([label, value]) => (
          <Box key={String(label)} p={3} bg="sunken" borderRadius="9px">
            <Text fontSize="11px" color="muted">
              {label}
            </Text>
            <Text fontWeight={600} fontSize="13.5px" overflowWrap="anywhere">
              {money(Number(value))}
            </Text>
          </Box>
        ))}
      </Grid>
      <Text fontSize="11.5px" color="ink2">
        已结算 {data.tokens.settledCalls} 次模型请求 · 输入 / 输出 Token：
        {data.tokens.inputTokens} / {data.tokens.outputTokens}
      </Text>
      <Text fontSize="11px" color="muted">
        缓存读取 / 写入 Token：{data.tokens.cacheReadTokens} /{" "}
        {data.tokens.cacheWriteTokens}；未知用量不记作 0。
      </Text>
      <Text fontSize="11px" color="muted" lineHeight={1.7}>
        额度可累计，不提现。模型请求期间临时预占余额，按平台价格结算后返还剩余；未知用量由管理员核对。按平台人民币单价计费。
      </Text>
    </Stack>
  );
}

/** 收支明细表；limit 用于管理员概览只显示最近几条。 */
export function WalletLedger({
  data,
  limit,
}: {
  data: WalletData;
  limit?: number;
}) {
  const rows = limit ? data.ledger.slice(0, limit) : data.ledger;
  if (!rows.length) return <Text fontSize="12px">暂无收支记录</Text>;
  return (
    <Box overflowX="auto">
      <Table size="sm" minW="620px">
        <Thead>
          <Tr>
            <Th textTransform="none" fontSize="10.5px" color="muted">时间</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted">说明</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted" isNumeric>金额</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted" isNumeric>余额</Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td fontSize="11px" whiteSpace="nowrap" color="muted">
                {new Date(row.createdAt).toLocaleString("zh-CN")}
              </Td>
              <Td fontSize="12px">{row.note}</Td>
              <Td fontSize="12px" isNumeric fontWeight={550}>
                {row.amount >= 0 ? "+" : ""}
                {money(row.amount)}
              </Td>
              <Td fontSize="11px" isNumeric color="muted">
                {money(row.balanceAfter)}
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Box>
  );
}

/** 模型用量表；保留扣费、预占、Token、平台承担和请求编号。 */
export function WalletUsage({
  data,
  limit,
}: {
  data: WalletData;
  limit?: number;
}) {
  const rows = limit ? data.requests.slice(0, limit) : data.requests;
  if (!rows.length) return <Text fontSize="12px">暂无模型用量</Text>;
  return (
    <Box overflowX="auto">
      <Table size="sm" minW="760px">
        <Thead>
          <Tr>
            <Th textTransform="none" fontSize="10.5px" color="muted">时间</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted">模型</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted">状态</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted" isNumeric>扣费/预占</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted" isNumeric>输入/输出</Th>
            <Th textTransform="none" fontSize="10.5px" color="muted">说明</Th>
          </Tr>
        </Thead>
        <Tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td fontSize="11px" whiteSpace="nowrap" color="muted">
                {new Date(row.createdAt).toLocaleString("zh-CN")}
              </Td>
              <Td fontSize="12px">{row.modelName}</Td>
              <Td fontSize="11.5px">{requestState(row.state)}</Td>
              <Td fontSize="12px" isNumeric whiteSpace="nowrap">
                {row.state === "settled"
                  ? money(row.charged ?? 0)
                  : money(row.reserved)}
                {!!row.waived && (
                  <Text fontSize="10px" color="muted">
                    平台承担 {money(row.waived)}
                  </Text>
                )}
              </Td>
              <Td fontSize="11px" isNumeric whiteSpace="nowrap">
                {row.inputTokens ?? "未知"} / {row.outputTokens ?? "未知"}
              </Td>
              <Td fontSize="10.5px" color="muted" maxW="220px">
                <Text noOfLines={2}>{row.note || "—"}</Text>
                <Text noOfLines={1} fontFamily="mono">
                  {row.id}
                </Text>
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Box>
  );
}

export function WalletDetails({
  data,
  title = "我的额度",
}: {
  data: WalletData;
  title?: string;
}) {
  return (
    <Stack spacing={4}>
      <Text fontWeight={600}>{title}</Text>
      <WalletSummary data={data} />
      <Text fontWeight={600} fontSize="13px">
        收支明细（最近100条）
      </Text>
      <WalletLedger data={data} />
      <Text fontWeight={600} fontSize="13px">
        模型用量（最近100次）
      </Text>
      <WalletUsage data={data} />
    </Stack>
  );
}
export function WalletPanel({ api }: { api: BrowserApi }) {
  const [data, setData] = useState<WalletData>();
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setData(await api.request<WalletData>("/wallet"));
      setError("");
    } catch (e) {
      setError(explain(e));
    }
  };
  useEffect(() => {
    void load();
  }, [api]);
  return (
    <Box
      border="1px solid"
      borderColor="line"
      p={4}
      rounded="14px"
      bg="surface"
    >
      <Button size="sm" mb={3} onClick={() => void load()}>
        刷新额度
      </Button>
      {error && (
        <Alert status="error">
          <AlertIcon />
          {error}
        </Alert>
      )}
      {data?.enabled === false && (
        <Alert status="warning">
          <AlertIcon />
          余额控制尚未启用
        </Alert>
      )}
      {data && <WalletDetails data={data} />}
    </Box>
  );
}
