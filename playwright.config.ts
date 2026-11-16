import { defineConfig, devices } from '@playwright/test';

// Seam 2: the player's message protocol in real Chromium.
// Locally the preinstalled Chromium is used (PLAYWRIGHT_BROWSERS_PATH); CI installs the matching build.
export default defineConfig({
  testDir: 'test/player',
  testMatch: '**/*.spec.ts',
  // Builds out/player, the bundle the specs load, so they test what the extension ships.
  globalSetup: './test/player/global-setup.ts',
  forbidOnly: true,
  fullyParallel: true,
  reporter: [['list']],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
