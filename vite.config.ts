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
    strictPort: true
  }
});
