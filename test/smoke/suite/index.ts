import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

/**
 * Thin VS Code smoke test, run inside a real VS Code by @vscode/test-electron (scripts/run-smoke.mjs).
 * It checks only what Seam 1 and Seam 2 cannot: that VS Code loads the extension and its contributions.
 * Ticket #13 adds activation, commands and keybindings here.
 */
export function run(): Promise<void> {
  return new Promise((resolve) => {
    const extension = vscode.extensions.getExtension('followalong.followalong');
    assert.ok(
      extension,
      'VS Code did not load the FollowAlong extension from the development path',
    );
    const manifest = extension.packageJSON as { displayName?: unknown };
    assert.equal(manifest.displayName, 'FollowAlong');
    process.stdout.write('smoke: the FollowAlong extension is loaded\n');
    resolve();
  });
}
