import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        // Tests mock harness modules, which only reaches the package's own imports when vitest transforms it.
        server: { deps: { inline: ['@x-tech-laboratories/smartharness'] } },
        include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
            thresholds: {
                autoUpdate: (newThreshold: number) => Math.floor(newThreshold),
                lines: 79,
                statements: 79,
                functions: 80,
                branches: 73,
            },
        },
    },
});
