import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Tauri watches src-tauri itself. Watching it here too (target/ above all)
    // crashes Vite's watcher with UNKNOWN errors inside OneDrive folders.
    watch: {
      ignored: ["**/src-tauri/**", "**/Plans/**", "**/scripts/**", "**/dist/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    // Second page: the dictation agent's overlay windows.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
      },
    },
  },
});
