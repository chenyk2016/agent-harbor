/** 公开的供应商预置；只含地址、协议和示例模型，不含密钥或价格。 */
export type ProviderFormat =
  | "anthropic"
  | "anthropic_compatible"
  | "openai_chat"
  | "openai_responses";

export interface ProviderPresetModel {
  id: string;
  name?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  group: "国际" | "国内" | "聚合" | "本地";
  format: ProviderFormat;
  apiBase: string;
  docsUrl?: string;
  keyHint?: string;
  models: ProviderPresetModel[];
  discovery?: {
    path: string;
    auth: "bearer" | "x-api-key";
    anthropicVersion?: string;
  };
}

// 模型示例只用于快捷填入；完整列表以供应商 /models 读取结果为准。
export const providerPresets: ProviderPreset[] = [
  {
    id: "openai", name: "OpenAI", group: "国际", format: "openai_chat",
    apiBase: "https://api.openai.com/v1", docsUrl: "https://platform.openai.com/docs",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "anthropic", name: "Anthropic", group: "国际", format: "anthropic",
    apiBase: "https://api.anthropic.com", docsUrl: "https://docs.anthropic.com",
    models: [
      { id: "claude-sonnet-5-5" },
      { id: "claude-opus-5-5" },
      { id: "claude-haiku-5-5" },
    ],
    discovery: { path: "/v1/models", auth: "x-api-key", anthropicVersion: "2023-06-01" },
  },
  {
    id: "gemini", name: "Google Gemini（OpenAI 兼容）", group: "国际", format: "openai_chat",
    apiBase: "https://generativelanguage.googleapis.com/v1beta/openai/",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    models: [{ id: "gemini-2.5-pro" }, { id: "gemini-2.5-flash" }],
    discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "openrouter", name: "OpenRouter", group: "国际", format: "openai_chat",
    apiBase: "https://openrouter.ai/api/v1", docsUrl: "https://openrouter.ai/docs",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "groq", name: "Groq", group: "国际", format: "openai_chat",
    apiBase: "https://api.groq.com/openai/v1", docsUrl: "https://console.groq.com/docs",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "mistral", name: "Mistral", group: "国际", format: "openai_chat",
    apiBase: "https://api.mistral.ai/v1", docsUrl: "https://docs.mistral.ai",
    models: [{ id: "mistral-large-latest" }, { id: "mistral-small-latest" }],
    discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "xai", name: "xAI", group: "国际", format: "openai_chat",
    apiBase: "https://api.x.ai/v1", docsUrl: "https://docs.x.ai",
    models: [{ id: "grok-3" }, { id: "grok-3-mini" }],
    discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "together", name: "Together AI", group: "国际", format: "openai_chat",
    apiBase: "https://api.together.xyz/v1", docsUrl: "https://docs.together.ai",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "fireworks", name: "Fireworks AI", group: "国际", format: "openai_chat",
    apiBase: "https://api.fireworks.ai/inference/v1", docsUrl: "https://docs.fireworks.ai",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "deepseek", name: "DeepSeek", group: "国内", format: "openai_chat",
    apiBase: "https://api.deepseek.com/v1", docsUrl: "https://api-docs.deepseek.com",
    models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
    discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "qwen", name: "阿里云百炼 / Qwen", group: "国内", format: "openai_chat",
    apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://help.aliyun.com/zh/model-studio",
    models: [{ id: "qwen-max" }, { id: "qwen-plus" }, { id: "qwen-turbo" }],
    discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "moonshot", name: "Moonshot / Kimi", group: "国内", format: "openai_chat",
    apiBase: "https://api.moonshot.cn/v1", docsUrl: "https://platform.moonshot.cn/docs",
    models: [{ id: "kimi-k2" }], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "zhipu", name: "智谱 GLM", group: "国内", format: "openai_chat",
    apiBase: "https://open.bigmodel.cn/api/paas/v4", docsUrl: "https://open.bigmodel.cn/dev/api",
    models: [{ id: "glm-4.5" }, { id: "glm-4-plus" }],
    discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "minimax", name: "MiniMax", group: "国内", format: "openai_chat",
    apiBase: "https://api.minimaxi.com/v1", docsUrl: "https://platform.minimaxi.com/document",
    models: [{ id: "MiniMax-M2" }], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "doubao", name: "火山方舟 / 豆包", group: "国内", format: "openai_chat",
    apiBase: "https://ark.cn-beijing.volces.com/api/v3", docsUrl: "https://www.volcengine.com/docs/82379",
    keyHint: "上游标识填接入点 ID，例如 ep-2026...", models: [],
    discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "qianfan", name: "百度千帆", group: "国内", format: "openai_chat",
    apiBase: "https://qianfan.baidubce.com/v2", docsUrl: "https://cloud.baidu.com/doc/qianfan-api",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "hunyuan", name: "腾讯混元", group: "国内", format: "openai_chat",
    apiBase: "https://api.hunyuan.cloud.tencent.com/v1", docsUrl: "https://cloud.tencent.com/document/product/1729",
    models: [{ id: "hunyuan-turbo" }], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "spark", name: "讯飞星火", group: "国内", format: "openai_chat",
    apiBase: "https://spark-api-open.xf-yun.com/v1", docsUrl: "https://www.xfyun.cn/doc/spark/",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "siliconflow", name: "硅基流动", group: "聚合", format: "openai_chat",
    apiBase: "https://api.siliconflow.cn/v1", docsUrl: "https://docs.siliconflow.cn",
    models: [], discovery: { path: "/models", auth: "bearer" },
  },
  {
    id: "ollama", name: "Ollama / vLLM（本地）", group: "本地", format: "openai_chat",
    apiBase: "http://host.docker.internal:11434/v1",
    keyHint: "本地服务没有密钥时可填任意非空值", models: [{ id: "llama3.2" }, { id: "qwen2.5" }],
    discovery: { path: "/models", auth: "bearer" },
  },
];
