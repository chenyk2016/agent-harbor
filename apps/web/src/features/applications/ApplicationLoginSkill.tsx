import { Button } from "@chakra-ui/react";
import { KeyRound } from "lucide-react";
import { applicationLoginCommand } from "../../../../../src/shared/application-skills.js";

/** 从应用创建的标题来源去掉原生技能命令，保留实际需求。 */
export function applicationRequirement(draft: string) {
  const value = draft.trim();
  const rest = value.slice(applicationLoginCommand.length);
  return value.startsWith(applicationLoginCommand) &&
    (!rest || /^\s/.test(rest))
    ? rest.trimStart()
    : value;
}

/** 将应用登录技能加入当前草稿，用户可以继续写需求，再决定何时发送。 */
export function ApplicationLoginSkill({
  draft,
  onChoose,
  disabled,
}: {
  draft: string;
  onChoose: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = applicationRequirement(draft) !== draft.trim();
  return (
    <Button
      type="button"
      size="xs"
      variant={selected ? "tint" : "ghost"}
      leftIcon={<KeyRound size={13} />}
      aria-pressed={selected}
      title={selected ? "从草稿移除应用登录 Skill" : "使用应用登录 Skill"}
      isDisabled={disabled}
      onClick={() =>
        onChoose(
          selected
            ? applicationRequirement(draft)
            : `${applicationLoginCommand} ${draft.trimStart()}`,
        )
      }
    >
      应用登录
    </Button>
  );
}
