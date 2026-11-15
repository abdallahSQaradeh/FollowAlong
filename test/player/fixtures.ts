import { test as base, expect } from '@playwright/test';

/**
 * Seam 2 fixture. Every browser console warning or error, and every uncaught page error,
 * is echoed with a "[browser console.<type>]" or "[browser pageerror]" tag so scripts/check-logs fails the run.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'warning' || type === 'error') {
        process.stderr.write(`[browser console.${type}] ${message.text()}\n`);
      }
    });
    page.on('pageerror', (error) => {
      process.stderr.write(`[browser pageerror] ${error.message}\n`);
    });
    await use(page);
  },
});

export { expect };
