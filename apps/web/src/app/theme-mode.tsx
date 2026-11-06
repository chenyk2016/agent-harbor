/** 浅色/深色/跟随系统：偏好存在本地，由根组件统一应用到 Chakra。 */
import { useColorMode } from "@chakra-ui/react";
import { useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const KEY = "agent-harbor:theme";
const EVENT = "ah-theme-change";
const isPreference = (value: string | null): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

export function getThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(KEY);
    return isPreference(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function setThemePreference(preference: ThemePreference) {
  try {
    localStorage.setItem(KEY, preference);
  } catch {
    // 私密窗口可能拒绝存储；本次切换仍然生效。
  }
  window.dispatchEvent(new Event(EVENT));
}

export function ThemeController() {
  const { setColorMode } = useColorMode();
  const [preference, setPreference] = useState<ThemePreference>(
    getThemePreference,
  );

  useEffect(() => {
    const update = () => setPreference(getThemePreference());
    window.addEventListener(EVENT, update);
    return () => window.removeEventListener(EVENT, update);
  }, []);

  useEffect(() => {
    if (preference !== "system") {
      setColorMode(preference);
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setColorMode(media.matches ? "dark" : "light");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference, setColorMode]);

  return null;
}
