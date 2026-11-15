import { defineConfig } from 'vitest/config';

// Seam 1: the FollowAlong core, driven through its ports with fakes and a real temp-dir file system.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    // Vitest prints console.warn/console.error as "stderr | <test>"; scripts/check-logs fails on it.
    reporters: ['default'],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
