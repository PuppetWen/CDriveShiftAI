import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { textScaleCssPlugin } from "./scripts/text-scale-css";

export default defineConfig({
  plugins: [textScaleCssPlugin(), react()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: true
  },
  server: {
    port: 5173,
    strictPort: true,
    // Browser profiles and native build caches contain exclusively locked files.
    // Test fixtures can still be served without watching their generated data.
    watch: { ignored: ["**/.test-tmp/**", "**/.task-tmp/**", "**/.cache/**"] }
  }
});
