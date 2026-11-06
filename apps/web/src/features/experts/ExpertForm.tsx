/** 表单只收业务说明和具体版本；不向浏览器开放权限、镜像或系统配置。 */
import {
  Box,
  Checkbox,
  FormControl,
  FormLabel,
  HStack,
  Input,
  Stack,
  Text,
  Textarea,
  Button,
} from "@chakra-ui/react";
import { Select } from "../../shared/select.js";
import type { ExpertDefinition, SkillChoice } from "./types.js";
export function ExpertForm({
  value,
  choices,
  editable,
  busy,
  change,
}: {
  value: ExpertDefinition;
  choices: SkillChoice[];
  editable: boolean;
  busy: boolean;
  change(value: ExpertDefinition): void;
}) {
  const fields = [
    ["name", "名称", "例如：数据分析专家", 40],
    ["description", "简介", "适合解决什么问题", 200],
    ["role", "角色与范围", "负责哪些工作，什么情况下先询问用户", 6000],
    ["workflow", "工作方法", "按什么步骤开展工作", 6000],
    ["output", "输出要求", "交付什么成果，使用什么格式", 6000],
  ] as const;
  const groups = [...new Set(choices.map((item) => item.skillId))]
    .map((id) => choices.filter((item) => item.skillId === id))
    .filter(
      (group) =>
        editable ||
        group.some((item) => value.skillVersionIds.includes(item.id)),
    );
  return (
    <Stack spacing={5}>
      {fields.map(([key, label, placeholder, max]) => (
        <FormControl key={key} isRequired>
          <FormLabel>{label}</FormLabel>
          {key === "name" || key === "description" ? (
            <Input
              aria-label={`专家${label}`}
              value={value[key]}
              placeholder={placeholder}
              maxLength={max}
              isReadOnly={!editable || busy}
              onChange={(e) => change({ ...value, [key]: e.target.value })}
            />
          ) : (
            <Textarea
              aria-label={`专家${label}`}
              value={value[key]}
              placeholder={placeholder}
              maxLength={max}
              rows={4}
              isReadOnly={!editable || busy}
              onChange={(e) => change({ ...value, [key]: e.target.value })}
            />
          )}
        </FormControl>
      ))}
      <FormControl>
        <FormLabel>开场示例（最多 3 条，每行一条）</FormLabel>
        <Textarea
          aria-label="专家开场示例"
          rows={3}
          value={value.examples.join("\n")}
          isReadOnly={!editable || busy}
          onChange={(e) =>
            change({ ...value, examples: e.target.value.split("\n") })
          }
        />
      </FormControl>
      <Box>
        <Text fontWeight={600} mb={2}>
          绑定技能
        </Text>
        <Text color="muted" fontSize="sm" mb={4}>
          选择具体版本。安装专家不会改变「我的技能」中的默认开关；不绑定也保留
          Claude 默认技能。
        </Text>
        <Stack spacing={3}>
          {groups.map((group) => {
            const selected = group.find((item) =>
              value.skillVersionIds.includes(item.id),
            );
            return (
              <HStack key={group[0].skillId} flexWrap="wrap" gap={3}>
                <Checkbox
                  aria-label={`绑定 ${group[0].name}`}
                  isChecked={!!selected}
                  isDisabled={!editable || busy}
                  onChange={(e) =>
                    change({
                      ...value,
                      skillVersionIds: e.target.checked
                        ? [...value.skillVersionIds, group[0].id]
                        : value.skillVersionIds.filter(
                            (id) => !group.some((item) => item.id === id),
                          ),
                    })
                  }
                >
                  {group[0].name}
                </Checkbox>
                <Select
                  ariaLabel={`${group[0].name}的版本`}
                  width="130px"
                  value={selected?.id ?? group[0].id}
                  disabled={!editable || busy || !selected}
                  onChange={(selectedId) =>
                    change({
                      ...value,
                      skillVersionIds: value.skillVersionIds.map((id) =>
                        id === selected?.id ? selectedId : id,
                      ),
                    })
                  }
                  options={group.map((item) => ({
                    value: item.id,
                    label: `v${item.version}`,
                  }))}
                />
              </HStack>
            );
          })}
          {!groups.length && (
            <Text color="muted">
              {editable
                ? "暂无可绑定技能，可以先创建纯角色专家。"
                : "未绑定额外技能。"}
            </Text>
          )}
          {value.skillVersionIds
            .filter((id) => !choices.some((item) => item.id === id))
            .map((id) => (
              <HStack key={id}>
                <Text color="red.600" fontSize="sm">
                  引用的技能已不可用：{id}
                </Text>
                {editable && (
                  <Button
                    size="sm"
                    onClick={() =>
                      change({
                        ...value,
                        skillVersionIds: value.skillVersionIds.filter(
                          (item) => item !== id,
                        ),
                      })
                    }
                  >
                    移除引用
                  </Button>
                )}
              </HStack>
            ))}
        </Stack>
      </Box>
    </Stack>
  );
}
