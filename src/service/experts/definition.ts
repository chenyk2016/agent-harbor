import type { ExpertDefinition } from "../../shared/experts.js";
import { fail } from "../types.js";
import { requireId } from "../skills/service.js";
/** 表单只接受业务字段；编译是确定的字符串拼接，不调用模型。 */
export function definition(value: unknown): ExpertDefinition {
  if (!value || typeof value !== "object") fail(400, "INVALID_EXPERT");
  const input = value as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.length > max)
      fail(400, "INVALID_EXPERT");
    return value.trim();
  };
  if (
    !Array.isArray(input.examples) ||
    input.examples.length > 3 ||
    input.examples.some((item) => typeof item !== "string" || item.length > 300)
  )
    fail(400, "INVALID_EXPERT");
  if (
    !Array.isArray(input.skillVersionIds) ||
    input.skillVersionIds.length > 20
  )
    fail(400, "INVALID_EXPERT");
  const ids = input.skillVersionIds.map(requireId);
  if (new Set(ids).size !== ids.length) fail(400, "INVALID_EXPERT");
  const result = {
    name: text("name", 40),
    description: text("description", 200),
    role: text("role", 6000),
    workflow: text("workflow", 6000),
    output: text("output", 6000),
    examples: (input.examples as string[])
      .map((item) => item.trim())
      .filter(Boolean),
    skillVersionIds: ids.sort(),
  };
  if (
    result.role.length + result.workflow.length + result.output.length >
    12000
  )
    fail(400, "INVALID_EXPERT");
  return result;
}
export const instructions = (value: ExpertDefinition) =>
  value.workbuddy
    ? value.workbuddy.agents[value.workbuddy.agentName].prompt
    : `# 当前专家：${value.name}\n\n## 角色与范围\n${value.role}\n\n## 工作方法\n${value.workflow}\n\n## 输出要求\n${value.output}\n`;
