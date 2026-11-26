import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server_port = Number(process.env.PORT ?? 7770);

// The page for a browser, with relative paths so a proxy can serve it under a folder.
export default defineConfig({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../out/web", emptyOutDir: true },
  // The dev page reaches the API through the separately running server; the slash keeps the page's own api.ts out of it.
  server: { proxy: { "/api/": `http://127.0.0.1:${server_port}`, "/login": `http://127.0.0.1:${server_port}` } },
});
