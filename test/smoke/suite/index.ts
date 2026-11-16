import * as assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import * as vscode from 'vscode';

/**
 * Thin VS Code smoke test, run inside a real VS Code by @vscode/test-electron (scripts/run-smoke.mjs).
 * It checks only what Seam 1 and Seam 2 cannot: that VS Code loads and activates the extension,
 * registers its commands, shows the player in an editor group beside the code, and that the real
 * page plays the Lesson there (asWebviewUri through the CSP, localResourceRoots, Electron's
 * autoplay policy). It also checks the default keybindings, and what a command sent to the player
 * does in the real page: the play/pause command is what the keybindings run.
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
  for (const command of ['followalong.openCourse', 'followalong.playPause']) {
    assert.ok(registered.includes(command), `${command} is not registered`);
  }
  say('its commands are registered');

  playPauseIsBoundToItsKeys(extension.packageJSON);
  say('FollowAlong: Play/Pause is in the Command Palette and bound to its default keys');

  await opensACourseBesideTheCode(extension.extensionPath);
  say('a Course opens in an editor group beside the code, and the open folder is unchanged');

  say(await theLessonStarts(hooks.playerEvents));
  say(await playPauseFromTheEditor(hooks.playerEvents));
}

interface Contributes {
  readonly commands?: readonly { command?: string; title?: string; category?: string }[];
  readonly keybindings?: readonly {
    command?: string;
    key?: string;
    mac?: string;
    when?: string;
  }[];
}

/** The manifest's commands and keybindings: what VS Code reads to fill the Command Palette and the keys. */
function playPauseIsBoundToItsKeys(packageJson: unknown): void {
  const { contributes } = packageJson as { contributes?: Contributes };
  const command = contributes?.commands?.find((entry) => entry.command === 'followalong.playPause');
  assert.deepEqual(
    { title: command?.title, category: command?.category },
    { title: 'Play/Pause', category: 'FollowAlong' },
    'the Command Palette entry is "FollowAlong: Play/Pause"',
  );
  const bindings = (contributes?.keybindings ?? []).filter(
    (entry) => entry.command === 'followalong.playPause',
  );
  assert.deepEqual(
    bindings.map(({ key, mac, when }) => ({ key, mac, when })),
    [
      {
        key: 'ctrl+alt+space',
        mac: 'cmd+alt+space',
        when: '(editorTextFocus || terminalFocus) && !suggestWidgetVisible && !terminalSuggestWidgetVisible',
      },
      { key: "ctrl+' space", mac: "cmd+' space", when: 'editorTextFocus || terminalFocus' },
    ],
  );
}

/**
 * Runs the play/pause command from the editor, as the keybinding does, and reports what the real
 * page did. Whether `play` sent from an extension command starts playback without any click in
 * the webview (spec #12, D3) is measured here, not assumed: the outcome is reported either way.
 */
async function playPauseFromTheEditor(events: readonly SeenEvent[]): Promise<string> {
  const lessonId = 'lesson.webm';
  const code = vscode.window.activeTextEditor?.document;
  assert.ok(code, 'the code editor is not active');
  const stateOf = (): string | undefined =>
    events
      .filter(
        (event) =>
          event.lessonId === lessonId && (event.type === 'played' || event.type === 'paused'),
      )
      .at(-1)?.type;
  const press = async (): Promise<number> => {
    const from = events.length;
    await vscode.commands.executeCommand('followalong.playPause');
    assert.equal(vscode.window.activeTextEditor?.document, code, 'the command moved the focus');
    return from;
  };
  const eventAfter = (from: number, wanted: (event: SeenEvent) => boolean) =>
    waitFor('the player to answer the command', () => events.slice(from).find(wanted), 10_000);
  const isPlayed = (event: SeenEvent) => event.lessonId === lessonId && event.type === 'played';
  const isPaused = (event: SeenEvent) => event.lessonId === lessonId && event.type === 'paused';

  if (!events.some(isPlayed)) {
    // The Lesson never played: VS Code refused autoplay. Does a command's `play` get through?
    const from = await press();
    const answer = await eventAfter(from, (event) => isPlayed(event) || isPaused(event));
    if (answer.type !== 'played') {
      // Nothing to assert beyond the report: the core shows "Press play" for this case.
      return 'MEASURED: play sent from the command did NOT start playback without a click (the player refused it again, paused {byUser: false})';
    }
    const next = await press();
    const paused = await eventAfter(next, isPaused);
    assert.equal(
      paused.byUser,
      false,
      'the pause the command asked for is reported as the learner’s',
    );
    return 'MEASURED: play sent from the command started playback without a click (autoplay had been refused); the command then paused it';
  }
  // Autoplay worked here, so the refused case is not measured. The 3 s fixture may also have
  // ended by now: then the command plays it again, and otherwise it pauses it and plays it again.
  const playingNow = stateOf() === 'played';
  const first = await press();
  if (playingNow) {
    const paused = await eventAfter(first, isPaused);
    assert.equal(
      paused.byUser,
      false,
      'the pause the command asked for is reported as the learner’s',
    );
    await eventAfter(await press(), isPlayed);
  } else {
    await eventAfter(first, isPlayed);
  }
  return 'MEASURED: autoplay worked in this VS Code, so the refused case was not reached; the command paused and played the Lesson again without a click';
}

/** Waits for the real player page to play the Lesson, or to report that autoplay was refused. */
async function theLessonStarts(events: readonly SeenEvent[]): Promise<string> {
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
