/** First-model setup. Browser storage keeps only resumable IDs, never the API key. */
import {
  Alert, AlertIcon, Box, Button, Checkbox, FormControl, FormLabel, Heading, HStack,
  Input, Link as ChakraLink, SimpleGrid, Spinner, Stack, Text,
} from "@chakra-ui/react";
import { ArrowLeft, Check, Circle, KeyRound, Menu, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../../../../src/clients/service-client.js";
import type { ModelProbeStatus } from "../../../../../src/shared/llm.js";
import type { ProviderPreset } from "../../../../../src/shared/provider-presets.js";
import { useWorkbench } from "../../app/workbench-context.js";
import { Select } from "../../shared/select.js";
import { explain } from "../../state/errors.js";
import type { AdminDeploymentDetail, AdminLlmOverview, Provider } from "../admin/types.js";
import { emptyPrice, priceFields, referencePrice, type PriceValues } from "./model-setup-prices.js";

type Draft = { provider?: string; providerRequest?: string; model?: string; modelRequest?: string; probe?: string; gift?: string; giftAmount?: string; chat?: string };
type Discovered = { id: string; displayName?: string };
type Wallet = { enabled: boolean; available: number };
const root = "/admin/llm/setup";
const formats = [
  { value: "openai_chat", label: "OpenAI Chat Completions" },
  { value: "openai_responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic 原生" },
  { value: "anthropic_compatible", label: "Anthropic 兼容" },
];

const diagnostics: Record<string, string> = {
  MODEL_PROBE_SYNC_FAILED: "配置已保存，暂时无法同步到网关。请检查网关连接后重试。",
  MODEL_PROBE_UPSTREAM_AUTH: "供应商拒绝了 API Key。更换密钥后可以在这里重试。",
  MODEL_PROBE_UPSTREAM_MODEL: "供应商找不到这个模型，或该密钥无权调用。请返回选择模型。",
  MODEL_PROBE_FAILED: "Agent 没有完成测试。请检查供应商用量、接口地址和运行环境，再重试。",
  MODEL_PROBE_TOOL_FAILED: "模型有回复，但没有成功读取指定文件。请换一个支持工具调用的模型。",
  MODEL_PROBE_STREAM_FAILED: "工具已运行，但没有收到正确的流式结果。请重试或换一个模型。",
  MODEL_PROBE_TIMEOUT: "测试超时。请检查供应商响应或运行环境后重试。",
  MODEL_PROBE_VERSION_CHANGED: "测试时模型版本发生了变化，请重试。",
  MODEL_PROBE_CLEANUP_PENDING: "上次测试的环境仍待清理。请等清理完成后重试。",
  MODEL_PROBE_BUSY: "已有一个模型测试在运行，请稍等再重试。",
};

function loadDraft(key: string): Draft {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    return Object.fromEntries(["provider", "providerRequest", "model", "modelRequest", "probe", "gift", "giftAmount", "chat"]
      .filter(field => typeof raw?.[field] === "string").map(field => [field, raw[field]]));
  } catch {
    return {};
  }
}

function PriceGroup({ values, title, set }: { values: PriceValues; title: string; set(value: PriceValues): void }) {
  return (
    <Box>
      <Text fontWeight={650} fontSize="sm" mb={2}>{title}</Text>
      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={2}>
        {priceFields.map(([id, label]) => (
          <FormControl key={id}>
            <FormLabel fontSize="xs" color="muted">{label}</FormLabel>
            <Input aria-label={`${title} ${label}`} size="sm" inputMode="decimal" value={values[id]}
              onChange={event => set({ ...values, [id]: event.target.value })} placeholder="0.00" />
          </FormControl>
        ))}
      </SimpleGrid>
    </Box>
  );
}

export function ModelSetup() {
  const { api, bench, created, problem, openNavigation } = useWorkbench();
  const user = bench.work.userId;
  const storageKey = "harbor:model-setup:v1:" + user;
  const [draft, setDraft] = useState(() => loadDraft(storageKey));
  const [data, setData] = useState<AdminLlmOverview>();
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [wallet, setWallet] = useState<Wallet>();
  const [load, setLoad] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [step, setStep] = useState(1);
  const [selection, select] = useState("");
  const [provider, setProvider] = useState<Provider>();
  const [key, setKey] = useState("");
  const [customName, setCustomName] = useState("");
  const [address, setAddress] = useState("");
  const [format, setFormat] = useState(formats[0].value);
  const [models, setModels] = useState<Discovered[]>([]);
  const [discovery, setDiscovery] = useState("");
  const [looking, setLooking] = useState(false);
  const [discover, refreshDiscovery] = useState(0);
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [upstream, setUpstream] = useState("");
  const [cost, setCost] = useState(emptyPrice);
  const [price, setPrice] = useState(emptyPrice);
  const [confirmed, setConfirmed] = useState(false);
  const [editingPrices, editPrices] = useState(false);
  const [amount, setAmount] = useState(() => draft.giftAmount ?? "1");
  const [changingKey, changeKey] = useState(false);
  const [detail, setDetail] = useState<AdminDeploymentDetail>();
  const [probe, setProbe] = useState<ModelProbeStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function persist(next: Draft) {
    setDraft(next);
    sessionStorage.setItem(storageKey, JSON.stringify(next));
  }
  function showError(value: unknown) {
    if (value instanceof ApiError && (value.status === 401 || value.code === "ACCOUNT_DISABLED")) problem(value);
    else setError(value instanceof ApiError && diagnostics[value.code] ? diagnostics[value.code] : explain(value));
  }

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoadError("");
    void Promise.all([
      api.request<AdminLlmOverview>("/admin/llm", "GET", undefined, signal),
      api.request<{ presets: ProviderPreset[] }>("/admin/llm/presets", "GET", undefined, signal),
      api.request<Wallet>("/wallet", "GET", undefined, signal),
    ]).then(async ([overview, catalog, balance]) => {
      if (signal.aborted) return;
      const saved = loadDraft(storageKey);
      const previous = overview.providers.find(item => item.id === (saved.provider ?? saved.providerRequest));
      const model = overview.deployments.find(item => item.id === (saved.model ?? saved.modelRequest) &&
        item.currentVersion?.providerId === previous?.id && !item.archivedAt && !item.deletionState);
      const existing = model ? await api.request<AdminDeploymentDetail>(`/admin/llm/deployments/${model.id}`, "GET", undefined, signal) : undefined;
      if (signal.aborted) return;
      setData(overview);
      setPresets(catalog.presets);
      setWallet(balance);
      if (previous) {
        setProvider(previous);
        select("saved:" + previous.id);
        setStep(existing ? 3 : 2);
      }
      if (existing && model) {
        setDetail(existing);
        setUpstream(model.currentVersion?.upstreamModel ?? "");
      }
      if (previous || saved.provider) {
        const next = previous ? { ...saved, provider: previous.id, model: existing?.deployment.id, probe: existing ? saved.probe : undefined } : {};
        setDraft(next);
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      }
    }).catch(value => {
      if (signal.aborted) return;
      setLoadError(value instanceof ApiError && value.status === 403 ? "只有管理员可以接入模型。" : explain(value));
    });
    return () => controller.abort();
  }, [api, load, storageKey]);

  const providerId = provider?.id;
  useEffect(() => {
    if (step !== 2 || !providerId) return;
    const controller = new AbortController();
    setLooking(true);
    setDiscovery("");
    setModels([]);
    void api.request<{ models: Discovered[] }>(`/admin/llm/providers/${providerId}/discover`, "POST", {}, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setModels(value.models);
          if (!value.models.length) setDiscovery("供应商未返回模型列表。可以用下方的预设，或手动输入模型 ID。");
        }
      })
      .catch(value => {
        if (!controller.signal.aborted) setDiscovery(explain(value) + " 你仍可手动输入模型 ID。");
      })
      .finally(() => { if (!controller.signal.aborted) setLooking(false); });
    return () => controller.abort();
  }, [api, discover, providerId, step]);

  const probeId = draft.probe;
  useEffect(() => {
    if (!probeId || !detail || step !== 3) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const read = async () => {
      try {
        const state = await api.request<ModelProbeStatus>(`${root}/probe/${probeId}`, "GET", undefined, controller.signal);
        if (controller.signal.aborted) return;
        setProbe(state);
        if (state.status === "running") timer = window.setTimeout(() => void read(), 700);
      } catch (value) {
        if (controller.signal.aborted) return;
        if (value instanceof ApiError && value.status === 404) {
          setProbe({ id: probeId, deploymentId: detail.deployment.id, status: "failed", synced: false, tool: false, stream: false });
          setError("没有查到这次测试。若服务刚重启，请重新运行测试。");
        } else if (value instanceof ApiError && value.status === 401) problem(value);
        else {
          setError("暂时无法读取测试进度，恢复连接后会继续核对。");
          timer = window.setTimeout(() => void read(), 2500);
        }
      }
    };
    // Give the POST a chance to register the run before the first read.
    timer = window.setTimeout(() => void read(), 700);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [api, detail, problem, probeId, step]);

  const preset = presets.find(item => item.id === selection);
  const savedProvider = selection.startsWith("saved:") ? data?.providers.find(item => "saved:" + item.id === selection) : undefined;
  const providerPreset = presets.find(item => item.format === provider?.format && item.apiBase.replace(/\/$/, "") === provider.apiBase);
  const reference = referencePrice(provider, upstream);
  const requiresCost = !!data?.costPolicyRequired;
  const requiresPrice = !!wallet?.enabled;
  const missingFunds = !!(wallet?.enabled && wallet.available <= 0);
  const costNeeded = requiresCost || priceFields.some(([field]) => cost[field]);
  const priceNeeded = requiresPrice || priceFields.some(([field]) => price[field]);
  const validPrices = (!costNeeded || priceFields.every(([field]) => /^\d+(\.\d+)?$/.test(cost[field]))) &&
    (!priceNeeded || priceFields.every(([field]) => /^\d+(\.\d+)?$/.test(price[field])));
  const modelChoices = [...new Map([...providerPreset?.models.map(item => ({ id: item.id, displayName: item.name })) ?? [], ...models].map(item => [item.id, item])).values()];
  const visibleModels = modelChoices.filter(model => `${model.id} ${model.displayName ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 100);
  const suggested = providerPreset?.id === "deepseek" ? providerPreset.models[0] : undefined;
  const inProgress = probe?.status === "running";
  const savedVersion = detail?.versions.find(item => item.id === detail.deployment.currentVersionId);
  const sameModel = !!detail && savedVersion?.upstreamModel === upstream;
  const confirmFees = !sameModel && (requiresCost || requiresPrice);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await action(); } catch (value) { showError(value); }
    finally { setBusy(false); }
  }

  async function saveProvider() {
    let result = savedProvider;
    if (!result) {
      const id = draft.providerRequest ?? crypto.randomUUID();
      persist({ providerRequest: id });
      result = await api.request<Provider>(`${root}/providers/${id}`, "PUT", {
        name: preset?.name ?? customName.trim(), apiBase: preset?.apiBase ?? address.trim(),
        format: preset?.format ?? format, apiKey: key.trim(),
      });
    }
    setData(current => current && ({ ...current, providers: [...current.providers.filter(item => item.id !== result.id), result] }));
    setProvider(result);
    select("saved:" + result.id);
    setKey("");
    setDetail(undefined);
    setProbe(undefined);
    persist({ provider: result.id });
    chooseModel("");
    setStep(2);
  }

  function chooseModel(value: string) {
    const next = referencePrice(provider, value);
    setUpstream(value);
    setCost(next?.cost ?? emptyPrice);
    setPrice(next?.price ?? emptyPrice);
    setConfirmed(false);
    editPrices(false);
  }

  async function saveModel() {
    if (!provider) return;
    if (detail && sameModel) {
      setProbe(undefined);
      persist({ ...draft, probe: undefined, chat: undefined });
      setStep(3);
      return;
    }
    const id = detail ? crypto.randomUUID() : draft.modelRequest ?? crypto.randomUUID();
    persist({ ...draft, model: undefined, modelRequest: id });
    const value = await api.request<AdminDeploymentDetail>(`${root}/models/${id}`, "PUT", {
      providerId: provider.id, name: modelChoices.find(item => item.id === upstream)?.displayName ?? upstream,
      upstreamModel: upstream, ...(priceNeeded ? { price } : {}),
      ...(costNeeded ? { cost: {
        inputUsdPerMillion: cost.input, outputUsdPerMillion: cost.output,
        cacheReadUsdPerMillion: cost.cacheRead, cacheWriteUsdPerMillion: cost.cacheWrite, timeoutSeconds: 180,
      } } : {}),
    });
    setDetail(value);
    setProbe(undefined);
    persist({ ...draft, model: value.deployment.id, modelRequest: id, probe: undefined, chat: undefined });
    setStep(3);
  }

  async function addFunds() {
    const id = draft.gift ?? crypto.randomUUID();
    persist({ ...draft, gift: id, giftAmount: amount });
    await api.request("/admin/wallet/gifts", "POST", { id, amountYuan: amount, note: "首次模型接入", userIds: [user] });
    setWallet(await api.request<Wallet>("/wallet"));
    persist({ ...draft, gift: undefined, giftAmount: undefined });
  }

  async function testModel() {
    if (!detail) return;
    const id = crypto.randomUUID();
    persist({ ...draft, probe: id });
    setProbe({ id, deploymentId: detail.deployment.id, status: "running", synced: false, tool: false, stream: false });
    try {
      const state = await api.request<ModelProbeStatus>(`${root}/probe/${id}`, "POST", { deploymentId: detail.deployment.id });
      setProbe(state);
    } catch (value) {
      // A transport failure may occur after acceptance. Keep the ID and check progress.
      if (value instanceof ApiError && value.status !== 0) {
        persist({ ...draft, probe: undefined });
        setProbe(undefined);
      }
      throw value;
    }
  }

  async function startChat() {
    if (!detail) return;
    const id = draft.chat ?? crypto.randomUUID();
    persist({ ...draft, chat: id });
    const session = await api.request<{ id: string }>("/sessions", "POST", {
      title: "新的对话", deploymentId: detail.deployment.id, clientRequestId: id,
    });
    await created(session.id);
    sessionStorage.removeItem(storageKey);
  }

  function backToModel() {
    setProbe(undefined);
    chooseModel(upstream);
    setError("");
    setStep(2);
  }

  return (
    <Box flex="1" minW={0} overflowY="auto" bg="canvas" px={{ base: 4, md: 8 }} py={{ base: 5, md: 10 }}>
      <Stack maxW="660px" mx="auto" spacing={5}>
        <HStack justify="space-between">
          <Button size="sm" variant="ghost" as={Link} to="/" leftIcon={<ArrowLeft size={15} />}>返回工作台</Button>
          <Button display={{ base: "inline-flex", lg: "none" }} size="sm" variant="ghost" onClick={openNavigation} aria-label="打开导航"><Menu size={18} /></Button>
        </HStack>
        <Box>
          <Heading fontSize={{ base: "25px", md: "30px" }} letterSpacing="-.025em">接入第一个模型</Heading>
          <Text color="muted" mt={2} fontSize="sm">接好一个模型并验证工具调用，就能开始第一场对话。</Text>
        </Box>
        <SimpleGrid columns={3} gap={{ base: 2, md: 3 }} aria-label="接入进度">
          {["连接供应商", "选择模型", "测试与启用"].map((label, index) => (
            <Box key={label} borderTop="2px solid" borderColor={index < step ? "brand.500" : "line"} pt={2}
              color={index + 1 === step ? "ink" : "muted"} aria-current={index + 1 === step ? "step" : undefined}>
              <Text fontSize="xs" fontWeight={650}>{index + 1} · {label}</Text>
            </Box>
          ))}
        </SimpleGrid>
        {loadError ? (
          <Alert status="error" borderRadius="md"><AlertIcon /><Box flex="1">{loadError}</Box>
            <Button size="sm" onClick={() => setLoad(value => value + 1)}>重试</Button>
          </Alert>
        ) : !data || !wallet ? <Spinner aria-label="正在读取模型配置" /> : (
          <Stack spacing={5} border="1px solid" borderColor="line" borderRadius="xl" p={{ base: 4, md: 6 }} bg="surface">
            {error && <Alert status="error" borderRadius="md"><AlertIcon />{error}</Alert>}
            {step === 1 && (
              <Stack spacing={4} as="form" onSubmit={event => { event.preventDefault(); void perform(saveProvider); }}>
                <Heading size="sm">连接模型供应商</Heading>
                <FormControl isRequired>
                  <FormLabel>供应商</FormLabel>
                  <Select ariaLabel="供应商" value={selection || "none"} onChange={value => {
                    select(value === "none" ? "" : value); setKey(""); setError("");
                    if (draft.providerRequest) persist({ ...draft, providerRequest: undefined });
                  }} options={[
                    { value: "none", label: "选择供应商" },
                    { value: "custom", label: "自定义接口" },
                    ...data.providers.map(item => ({ value: "saved:" + item.id, label: item.name + " · 已连接" })),
                    ...presets.map(item => ({ value: item.id, label: item.name })),
                  ]} />
                </FormControl>
                {selection === "custom" && (
                  <>
                    <FormControl isRequired><FormLabel>供应商名称</FormLabel><Input value={customName} maxLength={200} onChange={event => setCustomName(event.target.value)} /></FormControl>
                    <FormControl isRequired><FormLabel>协议</FormLabel><Select ariaLabel="协议" value={format} options={formats} onChange={setFormat} /></FormControl>
                    <FormControl isRequired><FormLabel>API 地址</FormLabel><Input type="url" value={address} onChange={event => setAddress(event.target.value)} placeholder="https://example.com/v1" /></FormControl>
                  </>
                )}
                {selection && !savedProvider && (
                  <FormControl isRequired>
                    <FormLabel><HStack><KeyRound size={14} /><Text as="span">API Key</Text></HStack></FormLabel>
                    <Input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} maxLength={4096} placeholder="粘贴供应商发给你的密钥" />
                    {preset?.keyHint && <Text fontSize="xs" mt={2} color="muted">{preset.keyHint}</Text>}
                    {preset?.docsUrl && <ChakraLink isExternal href={preset.docsUrl} mt={2} display="inline-block" color="brand.500" fontSize="xs">查看供应商文档</ChakraLink>}
                  </FormControl>
                )}
                <Button alignSelf="flex-start" type="submit" isLoading={busy} isDisabled={!selection || (!savedProvider && !key.trim())}>保存并选择模型</Button>
              </Stack>
            )}
            {step === 2 && (
              <>
                <Box>
                  <Heading size="sm">选择一个模型</Heading>
                  <Text fontSize="sm" color="muted" mt={2}>{provider?.name} · 实际能否执行任务由下一步验证。</Text>
                </Box>
                {looking && <Text fontSize="xs" color="muted">正在读取供应商模型列表…</Text>}
                {discovery && <Alert status="warning" borderRadius="md" fontSize="sm">
                  <AlertIcon /><Box flex="1">{discovery}</Box>
                  <Button size="xs" variant="outline" onClick={() => changeKey(true)}>更换密钥</Button>
                </Alert>}
                {suggested && (
                  <Button alignSelf="flex-start" whiteSpace="normal" h="auto" minH={9} py={2} variant="outline"
                    leftIcon={<Sparkles size={15} />} onClick={() => chooseModel(suggested.id)}>
                    推荐先试 {suggested.name ?? suggested.id}
                  </Button>
                )}
                {!!modelChoices.length && <Button alignSelf="flex-start" size="sm" variant="ghost" onClick={() => setAll(!all)}>
                  {all ? "收起模型列表" : `查看模型列表（${modelChoices.length}）`}
                </Button>}
                {all && <>
                  <Input size="sm" aria-label="搜索供应商模型" placeholder="按模型名或 ID 搜索" value={filter} onChange={event => setFilter(event.target.value)} />
                  <Select ariaLabel="供应商模型列表" value={visibleModels.some(item => item.id === upstream) ? upstream : "__none__"} onChange={value => chooseModel(value === "__none__" ? "" : value)} options={[
                    { value: "__none__", label: visibleModels.length ? "从列表中选择" : "没有匹配的模型" },
                    ...visibleModels.map(item => ({ value: item.id, label: item.displayName && item.displayName !== item.id ? `${item.displayName} · ${item.id}` : item.id })),
                  ]} />
                  {modelChoices.length > 100 && <Text fontSize="xs" color="muted">最多显示前 100 个匹配项，可输入完整 ID 缩小范围。</Text>}
                </>}
                <FormControl isRequired>
                  <FormLabel>模型 ID</FormLabel>
                  <Input placeholder="从上方选用，或粘贴供应商给出的模型 ID" maxLength={200} value={upstream} onChange={event => chooseModel(event.target.value.trim())} />
                </FormControl>
                {sameModel && <Text fontSize="sm" color="muted">这个模型已经保存。价格可在模型管理页调整。</Text>}
                {!!upstream && confirmFees && (
                  <Stack spacing={3} bg="canvas" borderRadius="lg" p={4}>
                    <Text fontWeight={650}>费用与试用额度</Text>
                    {reference && <Text fontSize="xs" color="muted">
                      预填官方高峰单价，核对于 {reference.checked}。Harbor 按这里确认的固定价格扣除内部额度，缓存写入按未命中输入价计。
                      {" "}<ChakraLink isExternal href={reference.source} color="brand.500">官方价格</ChakraLink>
                    </Text>}
                    {reference && !editingPrices ? (
                      <>
                        {requiresCost && <Text fontSize="sm">供应商成本（美元 / 百万 Token） · 输入 {cost.input} / 输出 {cost.output} / 缓存读 {cost.cacheRead} / 缓存写 {cost.cacheWrite}</Text>}
                        {requiresPrice && <Text fontSize="sm">平台扣费（人民币 / 百万 Token） · 输入 {price.input} / 输出 {price.output} / 缓存读 {price.cacheRead} / 缓存写 {price.cacheWrite}</Text>}
                        <Button alignSelf="flex-start" size="xs" variant="outline" onClick={() => editPrices(true)}>编辑单价</Button>
                      </>
                    ) : (
                      <>
                        {requiresCost && <PriceGroup title="供应商成本（美元 / 百万 Token）" values={cost} set={value => { setCost(value); setConfirmed(false); }} />}
                        {requiresPrice && <PriceGroup title="平台扣费（人民币 / 百万 Token）" values={price} set={value => { setPrice(value); setConfirmed(false); }} />}
                      </>
                    )}
                    {requiresPrice && <Text fontSize="sm">当前可用额度 ¥{(wallet.available / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 })}</Text>}
                    <Checkbox isChecked={confirmed} onChange={event => setConfirmed(event.target.checked)}>我已核对上述单价</Checkbox>
                  </Stack>
                )}
                <HStack flexWrap="wrap">
                  <Button variant="ghost" onClick={() => { setError(""); setStep(1); }}>上一步</Button>
                  <Button isLoading={busy} isDisabled={!/^[a-zA-Z0-9_.:/@-]+$/.test(upstream) || (confirmFees && (!validPrices || !confirmed))}
                    onClick={() => void perform(saveModel)}>{sameModel ? "返回测试" : "保存并前往测试"}</Button>
                </HStack>
              </>
            )}
            {step === 3 && (
              <>
                <Box>
                  <Heading size="sm">验证 {detail?.deployment.name ?? upstream}</Heading>
                  <Text fontSize="sm" mt={2} color="muted">测试会使用供应商发起短任务，可能产生费用。此模型暂时仅当前管理员可用。</Text>
                </Box>
                {wallet.enabled && (
                  <Stack bg="canvas" borderRadius="lg" p={3} spacing={2}>
                    <Text fontSize="sm">当前可用额度 ¥{(wallet.available / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 6 })}</Text>
                    {(missingFunds || probe?.error === "INSUFFICIENT_BALANCE") && (
                      <>
                        <Text fontSize="xs" color="muted">给当前账号补内部额度。供应商余额仍由供应商管理。</Text>
                        <HStack>
                          <Input aria-label="补充额度（元）" size="sm" w="100px" inputMode="decimal" value={amount} isReadOnly={!!draft.gift} onChange={event => setAmount(event.target.value)} />
                          <Button size="sm" variant="outline" isLoading={busy} isDisabled={!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0} onClick={() => void perform(addFunds)}>给自己补额度</Button>
                        </HStack>
                      </>
                    )}
                  </Stack>
                )}
                <Stack spacing={2} aria-live="polite">
                  {[
                    [probe?.synced, "模型已同步到网关"],
                    [probe?.tool, "模型成功调用文件读取工具"],
                    [probe?.stream, "收到正确的流式回复"],
                  ].map(([done, label]) => (
                    <HStack key={String(label)} color={done ? "green.600" : "muted"} fontSize="sm">
                      {done ? <Check size={16} /> : <Circle size={15} />}
                      <Text>{label}</Text>
                    </HStack>
                  ))}
                  {probe?.status === "passed" && <Text fontSize="xs" color="muted">测试通过 · {((probe.durationMs ?? 0) / 1000).toFixed(1)} 秒</Text>}
                </Stack>
                {probe?.error && <Alert status="warning" borderRadius="md"><AlertIcon />{diagnostics[probe.error] ?? explain(new ApiError(409, probe.error))}</Alert>}
                <HStack flexWrap="wrap">
                  {probe?.status === "passed" ? (
                    <>
                      <Button isLoading={busy} onClick={() => void perform(startChat)}>开始第一场对话</Button>
                      <Button as={Link} to={`/admin/models?deployment=${detail?.deployment.id}`} variant="outline">管理模型与开放范围</Button>
                    </>
                  ) : (
                    <>
                      <Button isLoading={busy || inProgress} loadingText={inProgress ? "正在验证" : "处理中"}
                        isDisabled={missingFunds} onClick={() => void perform(testModel)}>{probe?.status === "failed" ? "重新测试" : "运行测试"}</Button>
                      <Button variant="ghost" isDisabled={busy || inProgress} onClick={backToModel}>返回选模型</Button>
                      <Button variant="ghost" isDisabled={busy || inProgress} onClick={() => changeKey(true)}>更换密钥</Button>
                    </>
                  )}
                </HStack>
              </>
            )}
            {changingKey && provider && (
              <Stack borderTop="1px solid" borderColor="line" pt={4} spacing={3} as="form"
                onSubmit={event => {
                  event.preventDefault();
                  void perform(async () => {
                    await api.request(`/admin/llm/providers/${provider.id}/secrets`, "POST", { apiKey: key.trim() });
                    setKey("");
                    changeKey(false);
                    if (step === 2) refreshDiscovery(value => value + 1);
                  });
                }}>
                <FormControl isRequired>
                  <FormLabel>新的 API Key</FormLabel>
                  <Input type="password" value={key} autoComplete="off" maxLength={4096} onChange={event => setKey(event.target.value)} />
                </FormControl>
                <Text fontSize="xs" color="muted">此供应商下的模型会使用新密钥。</Text>
                <HStack>
                  <Button type="submit" size="sm" isLoading={busy} isDisabled={!key.trim()}>保存新密钥</Button>
                  <Button size="sm" variant="ghost" onClick={() => { changeKey(false); setKey(""); }}>取消</Button>
                </HStack>
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
