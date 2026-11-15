import { defineConfig, devices } from '@playwright/test';

// Seam 2: the player's message protocol in real Chromium.
// Locally the preinstalled Chromium is used (PLAYWRIGHT_BROWSERS_PATH); CI installs the matching build.
export default defineConfig({
  testDir: 'test/player',
  testMatch: '**/*.spec.ts',
  forbidOnly: true,
  fullyParallel: true,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
