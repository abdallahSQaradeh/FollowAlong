import * as assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import * as vscode from 'vscode';

/**
 * Thin VS Code smoke test, run inside a real VS Code by @vscode/test-electron (scripts/run-smoke.mjs).
 * It checks only what Seam 1 and Seam 2 cannot: that VS Code loads and activates the extension,
 * registers its commands, shows the player in an editor group beside the code, and that the real
 * page plays the Lesson there (asWebviewUri through the CSP, localResourceRoots, Electron's
 * autoplay policy).
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

/** One entry of `contributes.keybindings` in package.json. */
interface SeenKeybinding {
  readonly command: string;
  readonly key: string;
  readonly when?: string;
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
  for (const command of [
    'followalong.openCourse',
    'followalong.playLesson',
    'followalong.goToLesson',
  ]) {
    assert.ok(registered.includes(command), `${command} is not registered`);
  }
  // VS Code adds a `.focus` command for every view it accepted from package.json: the FollowAlong
  // activity bar container and its Lessons tree.
  assert.ok(
    registered.includes('followalong.lessons.focus'),
    'VS Code did not register the followalong.lessons view',
  );
  say('its commands and the Lessons tree view are registered');

  // The chord Ctrl+' L opens the Lesson picker from the editor or the terminal. VS Code reads the
  // keybinding table from package.json; this checks it is declared with the right `when`.
  const keybindings = (
    extension.packageJSON as { contributes?: { keybindings?: readonly SeenKeybinding[] } }
  ).contributes?.keybindings;
  const goToLesson = keybindings?.find((binding) => binding.command === 'followalong.goToLesson');
  assert.ok(goToLesson, "Ctrl+' L is not bound to Go to Lesson…");
  assert.equal(goToLesson.key, "ctrl+' l");
  assert.equal(goToLesson.when, 'editorTextFocus || terminalFocus');
  say("Ctrl+' L is bound to Go to Lesson… in the editor and the terminal");

  await opensACourseBesideTheCode(extension.extensionPath);
  say('a Course opens in an editor group beside the code, and the open folder is unchanged');

  say(await theLessonStarts(hooks.playerEvents, 'lesson.webm'));

  // A click on a Lesson in the tree runs this command with the Lesson's id.
  await vscode.commands.executeCommand('followalong.playLesson', 'long.webm');
  say(await theLessonStarts(hooks.playerEvents, 'long.webm'));
}

/** Waits for the real player page to play the Lesson, or to report that autoplay was refused. */
async function theLessonStarts(events: readonly SeenEvent[], lessonId: string): Promise<string> {
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
    return `VS Code refused autoplay (paused {byUser: false}); the Lesson loaded (length ${String(loaded.duration)} s)`;
  }
  const progress = await waitFor('the playhead to move', () =>
    events.find(
      (event) =>
        event.type === 'timeUpdate' && event.lessonId === lessonId && (event.position ?? 0) > 0.2,
    ),
  );
  return `the Lesson plays in VS Code (played, then timeUpdate at ${String(progress.position)} s)`;
}

async function opensACourseBesideTheCode(extensionPath: string): Promise<void> {
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
}

async function waitFor<T>(what: string, find: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function say(line: string): void {
  process.stdout.write(`smoke: ${line}\n`);
}
