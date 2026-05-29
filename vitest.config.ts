import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    // Several tests mutate shared on-disk artifacts (hooks/hooks.json,
    // plugin manifests). Vitest's per-file parallelism races those writes,
    // producing flaky failures in setup-contracts-regression and
    // hooks-command-escaping when hud-marketplace-resolution runs concurrently.
    // Disable file parallelism so test files execute serially.
    fileParallelism: false,
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist', '.omc'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/**/*.{test,spec}.{js,ts}',
        '**/*.d.ts',
        '**/*.config.{js,ts}',
        '**/index.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
