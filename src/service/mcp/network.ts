/** URL validation only. Native HTTP owns networking; this module is not an egress proxy. */
import { isIP, BlockList } from "node:net";
import { fail } from "../types.js";
const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
export function publicAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  return (
    isIP(address) === 6 &&
    /^[23]/i.test(address) &&
    !/^(2001:(db8|0):|2002:)/i.test(address)
  );
}
export class McpNetwork {
  constructor(readonly allowedOrigins: string[] = []) {}
  url(raw: string) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      fail(400, "INVALID_MCP_URL");
    }
    const trusted = this.allowedOrigins.includes(u.origin);
    if (
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      (!trusted && u.protocol !== "https:") ||
      !["http:", "https:"].includes(u.protocol)
    )
      fail(400, "INVALID_MCP_URL");
    return u;
  }
}
