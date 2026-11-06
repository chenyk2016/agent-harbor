import { ApiError } from "../../../../../src/clients/service-client.js";
export function skillError(error: unknown) {
  const labels: Record<string, string> = {
    SKILL_SLUG_EXISTS:
      "这个英文标识已经存在，请修改标识，或导入为已有技能的新版本。",
    VERSION_CONFLICT: "技能已在其他页面更新，请重新打开详情，核对后再保存。",
    INVALID_SKILL_PACKAGE: "请检查 SKILL.md 中的名称、描述和文件路径。",
    SKILL_SLUG_IMMUTABLE: "英文标识不能修改，请新建技能。",
    INVALID_SKILL_NAME: "名称不能为空，且最多 200 个字符。",
    DEFAULT_REVISION_CONFLICT: "启用设置已变化，请刷新后重试。",
  };
  return error instanceof ApiError
    ? (labels[error.code] ?? `操作未完成：${error.code}`)
    : error instanceof Error
      ? error.message
      : "操作失败，请重试";
}
