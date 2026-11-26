import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Thunderbird add-on: its popup and options pages, with the manifest and icon copied beside them.
export default defineConfig({
  root: "thunderbird",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../out/thunderbird",
    emptyOutDir: true,
    // Thunderbird loads an add-on's scripts from its own files only, so nothing is inlined as a data: URL.
    assetsInlineLimit: 0,
    rollupOptions: { input: { popup: resolve("thunderbird/popup.html"), options: resolve("thunderbird/options.html") } },
  },
});
