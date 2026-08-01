import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    lib: {
      entry: "ui/boot.ts",
      formats: ["es"],
      fileName: () => "dev-ui.js",
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "dev-ui.css" : "[name][extname]",
      },
    },
  },
});
