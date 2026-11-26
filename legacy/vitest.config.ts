import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['src/assistant/identity.ts'],
        // Tests mock harness modules, which only reaches the package's own imports when vitest transforms it.
        server: { deps: { inline: ['@x-tech-laboratories/smartharness'] } },
        include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
            thresholds: {
                autoUpdate: (newThreshold: number) => Math.floor(newThreshold),
                lines: 68,
                statements: 67,
                functions: 65,
                branches: 66,
            },
        },
    },
});
