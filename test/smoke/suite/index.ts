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
 * autoplay policy). It also checks the default keybindings, and what a command sent to the player
 * does in the real page: the play/pause command is what the keybindings run. Then it clicks the
 * picture with real input over the DevTools protocol, to see that VS Code counts the click as a
 * user gesture (#12 D3) and that focus comes back to the code (ADR 0009).
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
  for (const command of [
    'followalong.openCourse',
    'followalong.playLesson',
    'followalong.playPause',
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

  playPauseIsBoundToItsKeys(extension.packageJSON);
  say('FollowAlong: Play/Pause is in the Command Palette and bound to its default keys');

  const code = await opensACourseBesideTheCode(extension.extensionPath);
  say('a Course opens in an editor group beside the code, and the open folder is unchanged');

  say(await theLessonStarts(hooks.playerEvents, 'lesson.webm'));
  say(await playFromTheEditor(hooks.playerEvents));
  await aClickOnThePicture(hooks.playerEvents, code);
  say(await playFromTheEditorAfterAClick(hooks.playerEvents));

  // A click on a Lesson in the tree runs this command with the Lesson's id.
  await vscode.commands.executeCommand('followalong.playLesson', 'long.webm');
  say(await theLessonStarts(hooks.playerEvents, 'long.webm'));
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
 * page did with its `play`. Whether that starts playback without any click in the webview (spec
 * #12, D3) only the real VS Code can say, so it is measured here and reported either way. What
 * the command sends in each state is covered at Seam 1.
 */
async function playFromTheEditor(events: readonly SeenEvent[]): Promise<string> {
  const lessonId = 'lesson.webm';
  const about = (type: string) => (event: SeenEvent) =>
    event.lessonId === lessonId && event.type === type;
  if (events.some(about('played'))) {
    return 'MEASURED: nothing, autoplay worked in this VS Code, so no play from a command was needed';
  }
  const code = vscode.window.activeTextEditor?.document;
  assert.ok(code, 'the code editor is not active');

  const from = events.length;
  await vscode.commands.executeCommand('followalong.playPause');
  assert.equal(vscode.window.activeTextEditor?.document, code, 'the command moved the focus');

  const answer = await waitFor(
    'the player to answer the play command',
    () => events.slice(from).find((event) => about('played')(event) || about('paused')(event)),
    10_000,
  );
  return answer.type === 'played'
    ? 'MEASURED: play sent from the command started playback without a click'
    : 'MEASURED: play sent from the command did NOT start playback without a click (the player refused it again, paused {byUser: false})';
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

/**
 * Clicks the middle of the picture in the real player page, as the learner's mouse would, then
 * checks that the click played (or paused) the Lesson and that keyboard focus came back to the
 * code editor. A Lesson VS Code would not start by itself shows whether the click is a user
 * gesture (#12 D3).
 */
async function aClickOnThePicture(
  events: readonly SeenEvent[],
  code: vscode.TextDocument,
): Promise<void> {
  const lessonId = 'lesson.webm';
  const port = process.env.FOLLOWALONG_SMOKE_DEVTOOLS_PORT;
  assert.ok(port, 'scripts/run-smoke.mjs passes the DevTools port');
  const wasPlaying = lastPlayState(events, lessonId) === 'played';
  // Keyboard focus in the player, where a learner's click leaves it. The click below comes from
  // the DevTools protocol, not from the OS, so it cannot be relied on to move VS Code's focus.
  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
  await waitFor('the player to have the focus', () =>
    vscode.window.activeTextEditor === undefined ? true : undefined,
  );
  const from = events.length;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = () => browser.contexts().flatMap((context) => context.pages());
  // The player page lives in an out-of-process frame that the DevTools connection does not
  // list, so the click goes to the workbench page at the middle of the player's <iframe>: the
  // middle of the picture. Chromium routes it into the player as real input.
  const player = await waitForAsync('the player <iframe> in the VS Code window', async () => {
    for (const page of pages()) {
      const frames = page.locator('iframe[src^="vscode-webview:"]');
      if ((await frames.count().catch(() => 0)) === 1) {
        const box = await frames.boundingBox();
        if (box !== null && box.width > 0 && box.height > 0) {
          return { page, box };
        }
      }
    }
    return undefined;
  }).catch((error: unknown) => {
    // Say which pages there were, so a failure in CI can be read without a rerun.
    const seen = pages().map((page) => page.url() || '(no URL)');
    throw new Error(`${String(error)}; pages seen: ${seen.join(', ') || 'none'}`);
  });
  await player.page.mouse.click(
    player.box.x + player.box.width / 2,
    player.box.y + player.box.height / 2,
  );

  const expected = wasPlaying ? 'paused' : 'played';
  await waitFor(`the player to report ${expected} after the click`, () =>
    events
      .slice(from)
      .find(
        (event) =>
          event.lessonId === lessonId &&
          event.type === expected &&
          (expected === 'played' || event.byUser === true),
      ),
  );
  say(
    wasPlaying
      ? 'a click on the picture pauses the Lesson, as the learner’s pause'
      : 'a click on the picture starts the Lesson VS Code would not start by itself: it is a user gesture (D3)',
  );
  await waitFor('the player to post userInteracted', () =>
    events.slice(from).find((event) => event.type === 'userInteracted'),
  );
  await waitFor('focus to come back to the code', () =>
    vscode.window.activeTextEditor?.document === code ? true : undefined,
  ).catch((error: unknown) => {
    const active = vscode.window.activeTextEditor?.document.uri.toString() ?? 'none';
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? 'none';
    throw new Error(`${String(error)}; active text editor: ${active}; active tab: ${tab}`);
  });
  say('with focus in the player, the click handed it back to the code editor');
}

/**
 * After the click, runs the play/pause command from the editor until it has to play, and reports
 * whether the page then played: whether one real click lets later commands start playback
 * (sticky user activation, ADR 0008). Measured and reported either way.
 */
async function playFromTheEditorAfterAClick(events: readonly SeenEvent[]): Promise<string> {
  const lessonId = 'lesson.webm';
  if (lastPlayState(events, lessonId) === 'played') {
    const from = events.length;
    await vscode.commands.executeCommand('followalong.playPause');
    await waitFor('the player to pause on the command', () =>
      events.slice(from).find((event) => event.lessonId === lessonId && event.type === 'paused'),
    );
  }
  const from = events.length;
  await vscode.commands.executeCommand('followalong.playPause');
  const answer = await waitFor('the player to answer the play command', () =>
    events
      .slice(from)
      .find(
        (event) =>
          event.lessonId === lessonId && (event.type === 'played' || event.type === 'paused'),
      ),
  );
  return answer.type === 'played'
    ? 'MEASURED: after one click in the player, play sent from the command starts playback'
    : 'MEASURED: after one click in the player, play sent from the command is still refused';
}

/** Whether the Lesson last reported `played` or `paused`. */
function lastPlayState(events: readonly SeenEvent[], lessonId: string): string | undefined {
  return events.findLast(
    (event) => event.lessonId === lessonId && (event.type === 'played' || event.type === 'paused'),
  )?.type;
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
