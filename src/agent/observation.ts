/** 跨轮次工具/子任务保留来源；未知来源不挂到新的前台轮次。 */
import type { Task } from "../shared/types.js";
export class ObservationOrigins {
  private tools = new Map<string, Task>();
  private prompts = new Map<string, Task>();
  private agents = new Map<string, Task>();
  private remember(map: Map<string, Task>, key: unknown, origin: Task | null) {
    if (typeof key !== "string" || !origin) return;
    map.set(key, origin);
    if (map.size > 4096) map.delete(map.keys().next().value!);
  }
  tool(id: string) {
    return this.tools.get(id) ?? null;
  }
  observe(
    type: string,
    p: Record<string, unknown>,
    active: Task | null,
  ): Task | null {
    const prompt =
      typeof p.promptId === "string" ? this.prompts.get(p.promptId) : undefined;
    const agent =
      typeof p.agentId === "string" ? this.agents.get(p.agentId) : undefined;
    if (type === "turn.observed") {
      this.remember(this.prompts, p.promptId, active);
      return active;
    }
    const tool =
      typeof p.toolUseId === "string" ? this.tools.get(p.toolUseId) : undefined;
    const origin =
      tool ??
      agent ??
      prompt ??
      (type === "tool.started" && !p.agentId ? active : null);
    if (type === "tool.started") {
      this.remember(this.tools, p.toolUseId, origin);
      this.remember(this.prompts, p.promptId, origin);
    }
    if (type === "agent.started") this.remember(this.agents, p.agentId, origin);
    return origin;
  }
}
