import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Tests read local dates, so every run uses the same time zone.
process.env.TZ = "UTC";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // The pre-merge assistant in legacy/ is kept for porting and is never run.
    exclude: [...configDefaults.exclude, "legacy/**"],
    // X-Libs' graph widget is run through Vite, so a test can stand in for force-graph, which needs a real canvas.
    server: { deps: { inline: [/x-libs\/dist\/web\/react\/graph/] } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "thunderbird/**/*.{ts,tsx}"],
      exclude: ["legacy/**"],
      thresholds: {
        // A point under the measure, so run-to-run noise cannot fail a run, and never below the floor already set.
        autoUpdate: (new_threshold, previous_threshold) => Math.max(previous_threshold, Math.floor(new_threshold) - 1),
        lines: 89,
        statements: 88,
        functions: 85,
        branches: 82,
      },
    },
  },
});
