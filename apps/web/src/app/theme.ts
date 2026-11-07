/** 设计 token 单一来源；浅色/暗色通过 Chakra semanticTokens 生效。 */
import { extendTheme } from "@chakra-ui/react";

const light = {
  canvas: "#FBFBFC",
  surface: "#FFFFFF",
  surfaceHover: "#F7F8FA",
  sunken: "#F3F4F6",
  line: "#EEF0F3",
  lineStrong: "#E2E4E8",
  ink: "#111827",
  ink2: "#374151",
  muted: "#8A94A6",
  brand: {
    50: "#EFF6FF",
    100: "#DBEAFE",
    200: "#BFDBFE",
    300: "#93C5FD",
    400: "#60A5FA",
    500: "#0A84FF",
    600: "#0071E3",
    700: "#005BB5",
    800: "#004890",
    900: "#003A75",
  },
  ok: "#10B981",
  okStrong: "#059669",
  okTint: "#ECFDF5",
  warn: "#D97706",
  warnStrong: "#B45309",
  warnTint: "#FFF7E6",
  danger: "#EF4444",
  dangerStrong: "#DC2626",
  dangerTint: "#FEF2F2",
};

const dark = {
  canvas: "#0B0F19",
  surface: "#111827",
  surfaceHover: "#1F2937",
  sunken: "#0F172A",
  line: "#1F2937",
  lineStrong: "#374151",
  ink: "#F9FAFB",
  ink2: "#D1D5DB",
  muted: "#9CA3AF",
  brand: {
    50: "#0B1F3A",
    100: "#10294A",
    200: "#163A6B",
    300: "#1E5099",
    400: "#2F7CD6",
    500: "#3B9EFF",
    600: "#5FB3FF",
    700: "#8CC9FF",
    800: "#B8DFFF",
    900: "#DCEFFF",
  },
  ok: "#34D399",
  okStrong: "#6EE7B7",
  okTint: "#0B2A1F",
  warn: "#FBBF24",
  warnStrong: "#FCD34D",
  warnTint: "#2A1F0B",
  danger: "#F87171",
  dangerStrong: "#FCA5A5",
  dangerTint: "#2A0F0F",
};

const pair = (key: keyof typeof light) => ({
  default: light[key],
  _dark: dark[key],
});

const semanticTokens = {
  colors: {
    onBrand: { default: "#FFFFFF", _dark: "#0B0F19" },
    canvas: pair("canvas"),
    surface: pair("surface"),
    surfaceHover: pair("surfaceHover"),
    sunken: pair("sunken"),
    line: pair("line"),
    lineStrong: pair("lineStrong"),
    ink: pair("ink"),
    ink2: pair("ink2"),
    muted: pair("muted"),
    brand: {
      50: { default: light.brand[50], _dark: dark.brand[50] },
      100: { default: light.brand[100], _dark: dark.brand[100] },
      200: { default: light.brand[200], _dark: dark.brand[200] },
      300: { default: light.brand[300], _dark: dark.brand[300] },
      400: { default: light.brand[400], _dark: dark.brand[400] },
      500: { default: light.brand[500], _dark: dark.brand[500] },
      600: { default: light.brand[600], _dark: dark.brand[600] },
      700: { default: light.brand[700], _dark: dark.brand[700] },
      800: { default: light.brand[800], _dark: dark.brand[800] },
      900: { default: light.brand[900], _dark: dark.brand[900] },
    },
    ok: pair("ok"),
    okStrong: pair("okStrong"),
    okTint: pair("okTint"),
    warn: pair("warn"),
    warnStrong: pair("warnStrong"),
    warnTint: pair("warnTint"),
    danger: pair("danger"),
    dangerStrong: pair("dangerStrong"),
    dangerTint: pair("dangerTint"),
  },
};

export const theme = extendTheme({
  config: {
    initialColorMode: "light",
    useSystemColorMode: false,
  },
  fonts: {
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    heading:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    mono: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
  },
  breakpoints: {
    base: "0em",
    sm: "30em",
    md: "48em",
    lg: "62em",
    app: "73.75em",
    xl: "80em",
    "2xl": "96em",
  },
  colors: light,
  semanticTokens,
  fontSizes: {
    xs: "11px",
    sm: "12.5px",
    md: "14px",
    lg: "15px",
    xl: "17px",
    "2xl": "22px",
    "3xl": "26px",
  },
  radii: {
    sm: "6px",
    md: "8px",
    lg: "12px",
    xl: "16px",
    "2xl": "20px",
  },
  shadows: {
    sm: "0 1px 2px rgba(0,0,0,.04)",
    md: "0 4px 12px rgba(0,0,0,.06)",
    lg: "0 12px 32px rgba(0,0,0,.12)",
  },
  styles: {
    global: {
      "html, body, #root": { minHeight: "100%" },
      "*": { boxSizing: "border-box" },
      body: {
        color: "ink",
        bg: "canvas",
        fontSize: "15px",
        lineHeight: 1.65,
        fontVariantNumeric: "tabular-nums",
      },
      "::selection": { bg: "brand.100" },
    },
  },
  components: {
    Button: {
      baseStyle: {
        fontWeight: 550,
        borderRadius: "8px",
        whiteSpace: "nowrap",
        _focusVisible: { boxShadow: "0 0 0 3px var(--ah-focus)" },
      },
      sizes: {
        md: { fontSize: "13px", h: "34px", px: "13px" },
        sm: { fontSize: "12px", h: "29px", px: "10px" },
        lg: { fontSize: "14px", h: "38px", px: "16px" },
      },
      variants: {
        solid: ({ colorScheme }: { colorScheme: string }) =>
          colorScheme === "brand"
            ? {
                bgGradient: "linear(to-br, #0A84FF, #00C6FB)",
                color: "onBrand",
                _hover: { bgGradient: "linear(to-br, #0071E3, #00B4E8)" },
                _active: { bgGradient: "linear(to-br, #005BB5, #0097D6)" },
              }
            : {},
        outline: {
          bg: "surface",
          color: "ink",
          border: "1px solid",
          borderColor: "lineStrong",
          _hover: { bg: "surfaceHover", borderColor: "muted" },
        },
        ghost: {
          bg: "transparent",
          color: "ink2",
          _hover: { bg: "surfaceHover", color: "ink" },
          _active: { bg: "sunken" },
        },
        tint: {
          bg: "brand.50",
          color: "brand.700",
          _hover: { bg: "brand.100" },
        },
        danger: {
          bg: "surface",
          color: "dangerStrong",
          border: "1px solid",
          borderColor: "danger",
          _hover: { bg: "dangerTint" },
        },
        link: {
          color: "brand.600",
          _hover: { textDecoration: "underline", textUnderlineOffset: "3px" },
        },
      },
      defaultProps: { colorScheme: "brand" },
    },
    IconButton: {
      baseStyle: {
        borderRadius: "8px",
        color: "ink2",
        _hover: { bg: "surfaceHover", color: "ink" },
        _focusVisible: { boxShadow: "0 0 0 3px var(--ah-focus)" },
      },
    },
    Input: {
      baseStyle: {
        field: {
          borderColor: "lineStrong",
          bg: "surface",
          color: "ink",
          _placeholder: { color: "muted" },
        },
      },
      sizes: {
        md: { field: { fontSize: "14px", h: "38px" } },
        sm: { field: { fontSize: "13px", h: "32px" } },
      },
      defaultProps: { focusBorderColor: "brand.500" },
    },
    Textarea: {
      baseStyle: {
        borderColor: "lineStrong",
        bg: "surface",
        color: "ink",
        fontSize: "14px",
        _placeholder: { color: "muted" },
      },
      defaultProps: { focusBorderColor: "brand.500" },
    },
    Select: {
      baseStyle: {
        field: { borderColor: "lineStrong", bg: "surface", color: "ink" },
      },
      sizes: { md: { field: { fontSize: "14px", h: "38px" } } },
      defaultProps: { focusBorderColor: "brand.500" },
    },
    Badge: {
      baseStyle: {
        textTransform: "none",
        borderRadius: "5px",
        px: 2,
        py: 0.5,
        fontWeight: 500,
        fontSize: "11px",
        bg: "sunken",
        color: "ink2",
      },
    },
    Kbd: {
      baseStyle: {
        bg: "surface",
        border: "1px solid",
        borderColor: "line",
        color: "muted",
        borderRadius: "4px",
        boxShadow: "none",
      },
    },
    Menu: {
      baseStyle: {
        list: {
          bg: "surface",
          borderColor: "line",
          color: "ink",
          boxShadow: "lg",
        },
        item: {
          bg: "surface",
          color: "ink2",
          _hover: { bg: "surfaceHover", color: "ink" },
          _focus: { bg: "surfaceHover", color: "ink" },
        },
      },
    },
    FormLabel: { baseStyle: { fontSize: "12.5px", color: "ink2", mb: 1.5 } },
    Heading: {
      baseStyle: {
        color: "ink",
        fontWeight: 650,
        letterSpacing: "-.01em",
      },
    },
    Modal: {
      baseStyle: {
        dialog: {
          borderRadius: "16px",
          color: "ink",
          boxShadow: "lg",
          bg: "surface",
        },
        header: { fontSize: "lg", fontWeight: 650, px: 6, pt: 6, pb: 0 },
        body: { px: 6, py: 4 },
        footer: { px: 6, pb: 6, gap: 3 },
      },
    },
    Drawer: { baseStyle: { dialog: { bg: "surface" } } },
    Tooltip: {
      baseStyle: {
        fontSize: "11px",
        borderRadius: "6px",
        bg: "ink",
        color: "canvas",
      },
    },
    Switch: {
      baseStyle: {
        track: { bg: "lineStrong", _checked: { bg: "brand.500" } },
        thumb: { bg: "surface" },
      },
    },
    Divider: { baseStyle: { borderColor: "line" } },
    Spinner: { baseStyle: { color: "brand.500" } },
  },
});
