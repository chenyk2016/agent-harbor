/** 自定义下拉组件：触发框走 Chakra，展开列表走 Radix + 全局样式，避免原生 <select> 的不可定制列表。 */
import * as SelectPrimitive from "@radix-ui/react-select";
import { Button } from "@chakra-ui/react";
import { Check, ChevronDown } from "lucide-react";

export interface Option {
  value: string;
  label: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "请选择",
  ariaLabel,
  width,
  maxW,
  flexShrink,
  disabled,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  ariaLabel?: string;
  width?: string | number;
  maxW?: string | number;
  flexShrink?: number;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          w={width ?? "full"}
          maxW={maxW}
          flexShrink={flexShrink}
          h={compact ? "30px" : "38px"}
          px={compact ? 2 : 3}
          justifyContent="space-between"
          fontWeight={compact ? 500 : 400}
          fontSize={compact ? "12px" : "13.5px"}
          borderRadius={compact ? "8px" : "9px"}
          textAlign="left"
          aria-label={ariaLabel}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon>
            <ChevronDown size={compact ? 14 : 16} color="var(--ah-muted)" />
          </SelectPrimitive.Icon>
        </Button>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="ah-select-content"
          style={{ minWidth: "var(--radix-select-trigger-width)" }}
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="ah-select-item"
              >
                <SelectPrimitive.ItemText>
                  {option.label}
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="ah-select-item-indicator">
                  <Check size={15} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
