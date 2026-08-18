import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    environment: 'node',
    // The end-to-end test drives real `git` subprocesses on a fixture repo; on a
    // cold Windows runner that is slower than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
