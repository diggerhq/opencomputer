import type { VendoTheme } from "@vendoai/vendo";

export const theme = {
  colors: {
    background: "#ffffff",
    surface: "#f8fafc",
    text: "#0f172a",
    muted: "#64748b",
    accent: "#2563eb",
    accentText: "#ffffff",
    danger: "#dc2626",
    border: "#e2e8f0",
  },
  typography: {
    fontFamily:
      "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    headingFamily:
      "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    baseSize: "16px",
  },
  radius: {
    small: "4px",
    medium: "8px",
    large: "12px",
  },
  density: "comfortable",
  motion: "full",
} satisfies VendoTheme;
