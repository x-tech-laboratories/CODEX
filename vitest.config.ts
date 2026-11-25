import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
            thresholds: {
                autoUpdate: (newThreshold: number) => Math.floor(newThreshold),
                lines: 80,
                statements: 80,
                functions: 80,
                branches: 74,
            },
        },
    },
});
