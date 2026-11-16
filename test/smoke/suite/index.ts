import * as assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** What `activate` returns in ExtensionMode.Test (src/adapters/vscode/extension.ts). */
interface TestHooks {
  readonly playerEvents: readonly SeenEvent[];
  lessonTree(): { readonly nodes: readonly TreeNode[] };
}

/** The part of a Lesson tree node this test reads (src/core/lesson-tree.ts). */
interface TreeNode {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly resources?: readonly TreeNode[];
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
    'followalong.attachResource',
    'followalong.openResource',
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

  await opensACourseBesideTheCode(extension.extensionPath);
  say('a Course opens in an editor group beside the code, and the open folder is unchanged');

  say(await theLessonStarts(hooks.playerEvents, 'lesson.webm'));

  // A click on a Lesson in the tree runs this command with the Lesson's id.
  await vscode.commands.executeCommand('followalong.playLesson', 'long.webm');
  say(await theLessonStarts(hooks.playerEvents, 'long.webm'));

  await aResourceOpensBesideTheCode(extension.extensionPath, hooks);
  say('a file attached to a Lesson shows under it and opens beside the code, next to the player');
}

/** Attaches a text file to a Lesson of a scratch Course, then opens it from the tree. */
async function aResourceOpensBesideTheCode(extensionPath: string, hooks: TestHooks): Promise<void> {
  // A scratch Course, so attaching never writes a `.followalong` folder into the repository.
  const scratch = mkdtempSync(join(tmpdir(), 'followalong-smoke-'));
  try {
    const course = join(scratch, 'Course');
    mkdirSync(course);
    copyFileSync(
      join(extensionPath, 'test', 'fixtures', 'media', 'lesson.webm'),
      join(course, 'lesson.webm'),
    );
    const notes = join(scratch, 'notes.ts');
    writeFileSync(notes, 'export const note = "beside the video";\n');
    const code = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: '1;\n',
    });
    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('followalong.openCourse', vscode.Uri.file(course));

    // The "+" on the Lesson runs this command with the Lesson's tree node.
    const lesson = hooks.lessonTree().nodes.find((node) => node.label === 'lesson.webm');
    assert.ok(lesson, 'the scratch Course shows no lesson.webm');
    await vscode.commands.executeCommand(
      'followalong.attachResource',
      lesson,
      vscode.Uri.file(notes),
    );
    const shown = await waitFor(
      'the Resource under its Lesson',
      () => hooks.lessonTree().nodes.find((node) => node.id === lesson.id)?.resources?.[0],
    );

    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('followalong.openResource', shown.id);
    const resourceGroup = await waitFor('the Resource tab', () =>
      vscode.window.tabGroups.all.find((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.fsPath === vscode.Uri.file(notes).fsPath,
        ),
      ),
    );
    assert.notEqual(
      resourceGroup.viewColumn,
      vscode.ViewColumn.One,
      'the file opened over the code',
    );
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputWebview &&
            tab.input.viewType.endsWith('followalong.player'),
        ),
      ),
      'opening the Resource closed the player',
    );
    assert.ok(!hooks.playerEvents.some((event) => event.type === 'error'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
