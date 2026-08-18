import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    environment: 'node',
    // The end-to-end tests drive real `git` subprocesses against fixture
    // repositories. On a cold Windows runner, or on a developer machine that is
    // also running something heavy, that is far slower than the 5s default —
    // measured at 60s+ under a load average of 57 on four cores.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
