import * as assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';
import * as vscode from 'vscode';

/**
 * Thin VS Code smoke test, run inside a real VS Code by @vscode/test-electron (scripts/run-smoke.mjs).
 * It checks only what Seam 1 and Seam 2 cannot: that VS Code loads and activates the extension,
 * registers its commands, shows the player in an editor group beside the code, and that the real
 * page plays the Lesson there (asWebviewUri through the CSP, localResourceRoots, Electron's
 * autoplay policy). Then it clicks the picture with real input over the DevTools protocol, to see
 * that VS Code counts it as a user gesture (#12 D3) and that focus comes back to the code.
 */

/** The part of a player event this test reads (src/protocol/player-messages.ts). */
interface SeenEvent {
  readonly type: string;
  readonly lessonId?: string;
  readonly byUser?: boolean;
  readonly position?: number;
  readonly duration?: number;
  readonly message?: string;
}

/** What `activate` returns in ExtensionMode.Test (src/adapters/vscode/extension.ts). */
interface TestHooks {
  readonly playerEvents: readonly SeenEvent[];
}
export async function run(): Promise<void> {
  // The suite runs inside the extension host, where Node prints a warning without saying who
  // caused it. Print its stack on one line, so the check-logs finding itself shows the caller.
  process.on('warning', (warning) => {
    const stack = (warning.stack ?? warning.message).split(/\r?\n\s*/).join(' <- ');
    say(`the extension host printed a warning: ${stack}`);
  });
  const extension = vscode.extensions.getExtension<TestHooks | undefined>(
    'followalong.followalong',
  );
  assert.ok(extension, 'VS Code did not load the FollowAlong extension from the development path');

  const hooks = await extension.activate();
  assert.ok(hooks, 'activate() returned no test hooks in ExtensionMode.Test');
  assert.equal(extension.isActive, true, 'the extension did not activate');
  say('the FollowAlong extension activates');

  const registered = await vscode.commands.getCommands(true);
  assert.ok(
    registered.includes('followalong.openCourse'),
    'followalong.openCourse is not registered',
  );
  say('its commands are registered');

  const code = await opensACourseBesideTheCode(extension.extensionPath);
  say('a Course opens in an editor group beside the code, and the open folder is unchanged');

  const autoplayRefused = await theLessonStarts(hooks.playerEvents);
  say(
    autoplayRefused
      ? 'VS Code refused autoplay (paused {byUser: false}); the Lesson loaded'
      : 'the Lesson plays in VS Code (played, then the playhead moved)',
  );

  await aClickOnThePicture(hooks.playerEvents, code, autoplayRefused);
}

/**
 * Clicks the middle of the picture in the real player page, then checks that the Lesson started
 * (or paused, if it was playing) and that keyboard focus went back to the code editor.
 */
async function aClickOnThePicture(
  events: readonly SeenEvent[],
  code: vscode.TextDocument,
  autoplayRefused: boolean,
): Promise<void> {
  const lessonId = 'lesson.webm';
  const port = process.env.FOLLOWALONG_SMOKE_DEVTOOLS_PORT;
  assert.ok(port, 'scripts/run-smoke.mjs passes the DevTools port');
  const activeEditors: (vscode.TextDocument | undefined)[] = [];
  const watch = vscode.window.onDidChangeActiveTextEditor((editor) => {
    activeEditors.push(editor?.document);
  });
  const before = events.length;
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const frames = () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .flatMap((page) => page.frames());
    // The player page is a frame inside the webview's frame, inside the workbench page.
    const overlay = await waitForAsync('the player page among the VS Code frames', async () => {
      for (const frame of frames()) {
        const found = frame.locator('.overlay');
        if ((await found.count().catch(() => 0)) === 1) {
          return found;
        }
      }
      return undefined;
    });
    await overlay.click({ timeout: 10_000 });

    const expected = autoplayRefused ? 'played' : 'paused';
    await waitFor(`the player to report ${expected} after the click`, () =>
      events
        .slice(before)
        .find(
          (event) =>
            event.lessonId === lessonId &&
            event.type === expected &&
            (expected === 'played' || event.byUser === true),
        ),
    );
    say(
      autoplayRefused
        ? 'a click on the picture starts the Lesson VS Code would not autoplay (a user gesture)'
        : 'a click on the picture pauses the Lesson, as the learner’s pause',
    );
    await waitFor('the player to post userInteracted', () =>
      events.slice(before).find((event) => event.type === 'userInteracted'),
    );
    await waitFor('focus to come back to the code', () =>
      activeEditors.at(-1) === code ? true : undefined,
    );
  } finally {
    watch.dispose();
  }
  assert.ok(
    activeEditors.includes(undefined),
    'the click never made the player the active editor, so focus return was not exercised',
  );
  assert.equal(vscode.window.activeTextEditor?.document, code, 'focus did not come back');
  say('the click moved focus to the player, and focus came back to the code editor');
}

/**
 * Waits for the real player page to play the Lesson, or to report that autoplay was refused.
 * Returns whether it was refused.
 */
async function theLessonStarts(events: readonly SeenEvent[]): Promise<boolean> {
  const lessonId = 'lesson.webm';
  const outcome = await waitFor(
    'the player to play the Lesson or to report a refused autoplay',
    () =>
      events.find(
        (event) =>
          event.lessonId === lessonId &&
          (event.type === 'played' ||
            event.type === 'error' ||
            (event.type === 'paused' && event.byUser === false)),
      ),
    20_000,
  );
  assert.notEqual(outcome.type, 'error', `the player failed: ${outcome.message ?? ''}`);
  if (outcome.type === 'paused') {
    // The media still has to come through asWebviewUri, the CSP and localResourceRoots: the
    // player reports the Lesson's length once MediaSource has read the file.
    const loaded = await waitFor('the player to report the Lesson’s length', () =>
      events.find(
        (event) =>
          event.type === 'timeUpdate' && event.lessonId === lessonId && (event.duration ?? 0) > 0,
      ),
    );
    assert.ok(
      !events.some((event) => event.type === 'error'),
      'the player reported an error after loading',
    );
    assert.ok((loaded.duration ?? 0) > 0);
    return true;
  }
  await waitFor('the playhead to move', () =>
    events.find(
      (event) =>
        event.type === 'timeUpdate' && event.lessonId === lessonId && (event.position ?? 0) > 0.2,
    ),
  );
  return false;
}

/** Opens the fixture Course beside a code editor, and returns that editor's document. */
async function opensACourseBesideTheCode(extensionPath: string): Promise<vscode.TextDocument> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'the smoke test runs with a workspace folder');
  const filesBefore = readdirSync(workspace.uri.fsPath);
  const code = await vscode.workspace.openTextDocument({
    language: 'javascript',
    content: 'const practice = true;\n',
  });
  await vscode.window.showTextDocument(code, vscode.ViewColumn.One);

  await vscode.commands.executeCommand(
    'followalong.openCourse',
    vscode.Uri.file(join(extensionPath, 'test', 'fixtures', 'media')),
  );

  const playerGroup = await waitFor('the player tab', () =>
    vscode.window.tabGroups.all.find((group) =>
      group.tabs.some(
        (tab) =>
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.endsWith('followalong.player'),
      ),
    ),
  );
  assert.equal(playerGroup.viewColumn, vscode.ViewColumn.Two, 'the player is not beside the code');
  assert.equal(
    vscode.window.visibleTextEditors.find((editor) => editor.document === code)?.viewColumn,
    vscode.ViewColumn.One,
    'the code is no longer in the first editor group',
  );
  assert.equal(vscode.window.activeTextEditor?.document, code, 'the player took the focus');
  assert.deepEqual(
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath),
    [workspace.uri.fsPath],
  );
  assert.deepEqual(readdirSync(workspace.uri.fsPath), filesBefore);
  return code;
}

async function waitForAsync<T>(
  what: string,
  find: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await find();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function waitFor<T>(what: string, find: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  return waitForAsync(what, () => Promise.resolve(find()), timeoutMs);
}

function say(line: string): void {
  process.stdout.write(`smoke: ${line}\n`);
}
