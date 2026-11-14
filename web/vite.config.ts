import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Pre-bundling breaks MapLibre's worker URL resolution in dev.
  optimizeDeps: { exclude: ["maplibre-gl"] },
});
