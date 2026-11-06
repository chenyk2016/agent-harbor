export const priceFields = [
  ["input", "输入"],
  ["output", "输出"],
  ["cacheRead", "缓存读取"],
  ["cacheWrite", "缓存写入"],
] as const;
export type PriceValues = Record<(typeof priceFields)[number][0], string>;
export const emptyPrice: PriceValues = { input: "", output: "", cacheRead: "", cacheWrite: "" };

export function referencePrice(provider: { apiBase: string; format: string } | undefined, model: string) {
  if (provider?.apiBase !== "https://api.deepseek.com/v1" ||
      provider.format !== "openai_chat" || model !== "deepseek-flash") return;
  // Harbor uses one fixed rate; the published peak rate is the conservative reference.
  // DeepSeek does not list a separate cache-write rate; it is mapped to cache-miss input.
  return {
    cost: { input: "0.3", output: "1.2", cacheRead: "0.006", cacheWrite: "0.3" },
    price: { input: "2", output: "8", cacheRead: "0.04", cacheWrite: "2" },
    source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
    checked: "2026-11-06",
  };
}
