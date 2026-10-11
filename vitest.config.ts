import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The server-boot test spawns the built artifacts; give it room.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      // index.ts is the stdio bootstrap — exercised end-to-end by
      // tests/server-boot.test.ts against the built artifacts, which v8
      // coverage of the in-process suite cannot see.
      exclude: ['src/index.ts'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
