import * as assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Browser, chromium } from '@playwright/test';
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
  /** What the PDF viewers reported (src/protocol/pdf-viewer-messages.ts). */
  readonly pdfViewerEvents: readonly { readonly type: string; readonly pages?: number }[];
  lessonTree(): { readonly nodes: readonly TreeNode[] };
  /** The status bar items VS Code shows, with the command each one runs. */
  statusBar(): readonly {
    readonly id: string;
    readonly text: string;
    readonly command?: { readonly id: string; readonly argument: unknown };
  }[];
  selectedLesson(): string | undefined;
  /** How many quick picks were shown so far. */
  quickPicksShown(): number;
  /** The label of the highlighted item of the quick pick shown last. */
  activeQuickPickItem(): string | undefined;
  /** The spot the player is in, and whether VS Code shows it. */
  playerSpot(): { readonly spot: string; readonly visible: boolean } | undefined;
  /** Whether the quick pick shown last still shows its busy indicator. */
  quickPickBusy(): boolean;
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
    'followalong.detachResource',
    'followalong.relinkResource',
    'followalong.playPause',
    'followalong.seekBackShort',
    'followalong.seekForwardShort',
    'followalong.seekBackLong',
    'followalong.seekForwardLong',
    'followalong.speedUp',
    'followalong.speedDown',
    'followalong.statusBarClick',
    'followalong.nextLesson',
    'followalong.previousLesson',
    'followalong.goToLesson',
    'followalong.attachToLoadedLesson',
    'followalong.moveVideo',
    'followalong.toggleLessonDone',
    'followalong.markLessonDone',
    'followalong.markLessonNotDone',
    'followalong.markSectionDone',
    'followalong.resetSection',
    'followalong.resetCourseProgress',
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
  // The video's own views: VS Code registers them only if it accepted their view containers in
  // the bottom panel and the secondary sidebar (`viewsContainers.panel` / `.secondarySidebar`).
  for (const view of ['followalong.videoPanel', 'followalong.videoSidebar']) {
    assert.ok(registered.includes(`${view}.focus`), `VS Code did not register the ${view} view`);
  }
  assert.equal(
    vscode.workspace.getConfiguration('followalong').get('videoLocation'),
    'editorSplit',
    'followalong.videoLocation defaults to the editor split',
  );
  say('the video views in the bottom panel and the secondary sidebar are registered');

  playPauseIsBoundToItsKeys(extension.packageJSON);
  say('FollowAlong: Play/Pause is in the Command Palette and bound to its default keys');
  goToLessonIsBoundToItsChord(extension.packageJSON);
  say("FollowAlong: Go to Lesson… is in the Command Palette and bound to Ctrl+' L");

  chordCommandsAreBound(extension.packageJSON, [
    ['speedUp', 'Speed up', "ctrl+' up"],
    ['speedDown', 'Speed down', "ctrl+' down"],
  ]);
  say("FollowAlong: Speed up / Speed down are in the Command Palette, bound to Ctrl+' ↑ / ↓");

  chordCommandsAreBound(extension.packageJSON, [['openCourse', 'Open Course…', "ctrl+' c"]]);
  assert.deepEqual(
    vscode.workspace.getConfiguration('followalong').get('coursesRoots'),
    [],
    'followalong.coursesRoots defaults to no root',
  );
  say("FollowAlong: Open Course… is bound to Ctrl+' C; no Courses root is set by default");

  chordCommandsAreBound(extension.packageJSON, [
    ['attachToLoadedLesson', 'Attach Resource', "ctrl+' a"],
  ]);
  say("FollowAlong: Attach Resource is in the Command Palette, bound to Ctrl+' A");

  chordCommandsAreBound(extension.packageJSON, [
    ['toggleLessonDone', 'Mark done / not done', "ctrl+' d"],
  ]);
  say("FollowAlong: Mark done / not done is in the Command Palette, bound to Ctrl+' D");

  chordCommandsAreBound(extension.packageJSON, [
    ['nextLesson', 'Next Lesson', "ctrl+' n"],
    ['previousLesson', 'Previous Lesson', "ctrl+' p"],
  ]);
  say(
    "FollowAlong: Next Lesson / Previous Lesson are in the Command Palette, bound to Ctrl+' N / P",
  );

  stepsAreBoundToTheirKeys(extension.packageJSON);
  say(
    'the four step commands are in the Command Palette, bound to their keys, with 5 s / 30 s steps',
  );

  resourceMenusAreDeclared(extension.packageJSON);
  progressMenusAreDeclared(extension.packageJSON);
  say(
    'the tree offers Detach on a Resource and Relink… on a missing one, and hides both from the Palette',
  );

  everyKeyWorksInTheTerminal(extension.packageJSON);
  say("every FollowAlong key, the Ctrl+' chords included, is bound while the terminal has focus");

  const code = await opensACourseBesideTheCode(extension.extensionPath);
  say('a Course opens in an editor group beside the code, and the open folder is unchanged');

  say(await theLessonStarts(hooks.playerEvents, 'lesson.webm'));
  say(await playFromTheEditor(hooks.playerEvents));
  await aClickOnThePicture(hooks.playerEvents, code);
  say(await playFromTheEditorAfterAClick(hooks.playerEvents));

  say(await theStatusBarRunsTheCommands(hooks));

  // A click on a Lesson in the tree runs this command with the Lesson's id.
  await vscode.commands.executeCommand('followalong.playLesson', 'long.webm');
  say(await theLessonStarts(hooks.playerEvents, 'long.webm'));

  // The Lesson tree is on screen, and the selection follows the Lesson the keys load.
  await vscode.commands.executeCommand('followalong.lessons.focus');
  await vscode.commands.executeCommand('followalong.previousLesson');
  await waitFor('the tree selecting the previous Lesson', () =>
    hooks.selectedLesson() === 'lesson.webm' ? true : undefined,
  );
  await vscode.commands.executeCommand('followalong.nextLesson');
  await waitFor('the tree selecting the next Lesson', () =>
    hooks.selectedLesson() === 'long.webm' ? true : undefined,
  );
  say('Previous Lesson and Next Lesson load their Lesson, and the tree selection follows it');

  const pickedRoot = mkdtempSync(join(tmpdir(), 'followalong-smoke-'));
  try {
    await aPickedCourseKeepsThePlayer(extension.extensionPath, hooks, pickedRoot, code);

    await aResourceOpensBesideTheCode(extension.extensionPath, hooks);
    say('a file attached to a Lesson shows under it and opens beside the code, next to the player');
  } finally {
    // aResourceOpensBesideTheCode closed every editor, the player too, which held the Lesson open.
    rmSync(pickedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }

  await resourcesOpenByType(extension.extensionPath, hooks);
  say('Markdown, HTML, an image and a PDF each open in their own kind of tab beside the code');

  await aLessonLoadsInEachSpot(extension.extensionPath, hooks);
}

/**
 * The three spots of #49 (ADR 0049): `followalong.videoLocation` opens the Lesson in the bottom
 * panel, and _Move video to…_ moves it to the secondary sidebar, beside the code, and back to the
 * panel. In each spot VS Code shows the player, a new page loads the Lesson through asWebviewUri,
 * the CSP and localResourceRoots, and the code keeps the focus. What a move carries (time, speed, play,
 * zoom) is covered at Seam 1 and Seam 2.
 */
async function aLessonLoadsInEachSpot(extensionPath: string, hooks: TestHooks): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'followalong-smoke-'));
  const settings = vscode.workspace.getConfiguration('followalong');
  try {
    const course = join(scratch, 'Spots Course');
    mkdirSync(course);
    copyFileSync(
      join(extensionPath, 'test', 'fixtures', 'media', 'lesson.webm'),
      join(course, 'spots.webm'),
    );
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const code = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: '2;\n',
    });
    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    await settings.update('videoLocation', 'bottomPanel', vscode.ConfigurationTarget.Global);

    let from = hooks.playerEvents.length;
    await vscode.commands.executeCommand('followalong.openCourse', vscode.Uri.file(course));
    say(await theLessonLoadsIn(hooks, 'bottomPanel', from, code));

    // Back into the bottom panel at the end: a view spot used before takes a new page.
    for (const spot of ['secondarySidebar', 'editorSplit', 'bottomPanel'] as const) {
      from = hooks.playerEvents.length;
      await vscode.commands.executeCommand('followalong.moveVideo', spot);
      say(await theLessonLoadsIn(hooks, spot, from, code));
    }
  } finally {
    await settings.update('videoLocation', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

/** Waits for a new page in `spot` to load the Lesson, with VS Code showing it and the code focused. */
async function theLessonLoadsIn(
  hooks: TestHooks,
  spot: string,
  from: number,
  code: vscode.TextDocument,
): Promise<string> {
  const lessonId = 'spots.webm';
  const since = () => hooks.playerEvents.slice(from);
  await waitFor(`a new player page in ${spot}`, () =>
    since().some((event) => event.type === 'ready') ? true : undefined,
  );
  const loaded = await waitFor(
    `the Lesson to load in ${spot}`,
    () => {
      const events = since();
      const failure = events.find((event) => event.type === 'error');
      assert.equal(failure, undefined, `the player failed in ${spot}: ${failure?.message ?? ''}`);
      const ready = events.findIndex((event) => event.type === 'ready');
      return events
        .slice(ready)
        .find(
          (event) =>
            event.type === 'timeUpdate' && event.lessonId === lessonId && (event.duration ?? 0) > 0,
        );
    },
    20_000,
  );
  const where = await waitFor(`VS Code to show the player in ${spot}`, () => {
    const hosted = hooks.playerSpot();
    return hosted?.spot === spot && hosted.visible ? hosted : undefined;
  });
  await waitFor(`the focus back in the code after the player opened in ${spot}`, () =>
    vscode.window.activeTextEditor?.document === code ? true : undefined,
  );
  return `the Lesson loads in the ${where.spot} spot (length ${String(loaded.duration)} s), and the code keeps the focus`;
}

/** A 1 × 1 PNG, for the image Resource. */
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Attaches a Markdown file, an HTML file, an image and a PDF to a Lesson and opens each from the
 * tree: each gets the kind of tab its type calls for, in a group that is not the player's, and the
 * code keeps the focus. Which kind a type gets is covered at Seam 1, and what the pages show and
 * run at Seam 2; this checks that VS Code accepts them.
 */
async function resourcesOpenByType(extensionPath: string, hooks: TestHooks): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'followalong-smoke-'));
  try {
    const course = join(scratch, 'Course');
    mkdirSync(course);
    copyFileSync(
      join(extensionPath, 'test', 'fixtures', 'media', 'lesson.webm'),
      join(course, 'lesson.webm'),
    );
    const files = {
      markdown: join(scratch, 'notes.md'),
      html: join(scratch, 'page.html'),
      image: join(scratch, 'pic.png'),
      pdf: join(scratch, 'sample.pdf'),
    };
    writeFileSync(files.markdown, '# Cheat sheet\n\nSee `map`.\n');
    writeFileSync(files.html, '<!doctype html><title>Page</title><h1>Closures</h1>\n');
    writeFileSync(files.image, onePixelPng);
    copyFileSync(join(extensionPath, 'test', 'fixtures', 'pdf', 'sample.pdf'), files.pdf);

    // A clean window: the groups the steps before left behind would decide where the player and
    // the Resources land, and this step is about where its own tabs go.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const code = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: '1;\n',
    });
    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('followalong.openCourse', vscode.Uri.file(course));
    const lesson = await waitFor('the scratch Course in the tree', () =>
      hooks.lessonTree().nodes.find((node) => node.id === 'lesson.webm'),
    );
    await waitFor('the player tab', () =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find(
          (tab) =>
            tab.input instanceof vscode.TabInputWebview &&
            tab.input.viewType.endsWith('followalong.player'),
        ),
    );
    const errorsBefore = hooks.playerEvents.filter((event) => event.type === 'error').length;

    const opened: vscode.Tab[] = [];
    for (const [index, file] of Object.values(files).entries()) {
      await vscode.commands.executeCommand(
        'followalong.attachResource',
        lesson,
        vscode.Uri.file(file),
      );
      const shown = await waitFor(
        `the Resource ${file} under its Lesson`,
        () => hooks.lessonTree().nodes.find((node) => node.id === lesson.id)?.resources?.[index],
      );
      await vscode.commands.executeCommand('followalong.openResource', shown.id);
    }
    const tabFor = (label: string): vscode.Tab | undefined =>
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.label === label);
    const kindOf = (tab: vscode.Tab): string =>
      tab.input instanceof vscode.TabInputWebview
        ? tab.input.viewType
        : tab.input instanceof vscode.TabInputCustom
          ? tab.input.viewType
          : tab.input instanceof vscode.TabInputText
            ? 'text'
            : 'other';
    const expectations: readonly (readonly [string, string])[] = [
      ['notes.md', 'followalong.preview'],
      ['page.html', 'followalong.preview'],
      ['pic.png', 'imagePreview.previewEditor'],
      ['sample.pdf', 'followalong.pdf'],
    ];
    for (const [label, kind] of expectations) {
      const tab = await waitFor(`the tab ${label}`, () => tabFor(label));
      opened.push(tab);
      // VS Code puts a prefix before the view type of a webview.
      assert.ok(kindOf(tab).endsWith(kind), `${label} opened as ${kindOf(tab)}, not as ${kind}`);
    }

    // Story 94: none of them covers the video or the code, and they collect in one group.
    const isPlayer = (tab: vscode.Tab): boolean =>
      tab.input instanceof vscode.TabInputWebview &&
      tab.input.viewType.endsWith('followalong.player');
    const playerGroup = vscode.window.tabGroups.all.find((group) => group.tabs.some(isPlayer));
    assert.ok(playerGroup, 'opening the Resources closed the player');
    assert.ok(playerGroup.activeTab && isPlayer(playerGroup.activeTab), 'the player is covered');
    const groups = new Set(opened.map((tab) => tab.group.viewColumn));
    assert.equal(groups.size, 1, 'the Resources did not open in one group');
    const [column] = [...groups];
    assert.notEqual(column, playerGroup.viewColumn, 'a Resource opened in the player’s group');
    assert.notEqual(column, vscode.ViewColumn.One, 'a Resource opened over the code');
    assert.equal(
      vscode.window.activeTextEditor?.document,
      code,
      'opening the Resources took the focus from the code',
    );

    // The PDF viewer drew the first page of the three-page fixture.
    await waitFor('the PDF viewer drawing the first page', () =>
      hooks.pdfViewerEvents.find((event) => event.type === 'rendered' && event.pages === 3),
    );
    assert.ok(!hooks.pdfViewerEvents.some((event) => event.type === 'failed'), 'the PDF failed');
    assert.equal(
      hooks.playerEvents.filter((event) => event.type === 'error').length,
      errorsBefore,
      'opening a Resource made the player report an error',
    );
  } finally {
    // The Resource tabs hold the scratch files open: Windows refuses to delete an open file.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * Sets a Courses root holding two Courses, opens the first one and clicks its player once, then
 * opens the second one through the Course picker, with the command `Ctrl+' C` runs. The second
 * Course must play in the same player page, which still has the click (#12 D3, ADR 0022): it
 * starts by itself. Also checks there was no close and the open folder is unchanged.
 */
async function aPickedCourseKeepsThePlayer(
  extensionPath: string,
  hooks: TestHooks,
  root: string,
  code: vscode.TextDocument,
): Promise<void> {
  // The Warm-up Course is opened first, so it is the Recent Course (open) at the top of the
  // picker, and "Picked Course" is the first of the other Courses: select the next item, accept it.
  const lessons = { warmUp: 'warm-up.webm', picked: 'picked.webm' } as const;
  for (const [folder, lesson] of [
    ['Warm-up Course', lessons.warmUp],
    ['Picked Course', lessons.picked],
  ] as const) {
    mkdirSync(join(root, folder));
    copyFileSync(
      join(extensionPath, 'test', 'fixtures', 'media', 'lesson.webm'),
      join(root, folder, lesson),
    );
  }
  const settings = vscode.workspace.getConfiguration('followalong');
  await settings.update('coursesRoots', [root], vscode.ConfigurationTarget.Global);
  try {
    const workspaceBefore = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath);
    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    // The first Course under the root: the player's folders change to the root, so its page
    // reloads, and starts without the click the earlier page had.
    await vscode.commands.executeCommand(
      'followalong.openCourse',
      vscode.Uri.file(join(root, 'Warm-up Course')),
    );
    const reloaded = await lessonStartsOrIsRefused(hooks.playerEvents, lessons.warmUp);
    say(
      reloaded === 'played'
        ? 'MEASURED: after the player page reloaded for other folders, the Lesson autoplayed (the earlier click still counts)'
        : 'MEASURED: after the player page reloaded for other folders, autoplay was refused (paused {byUser: false}): a reload loses the click',
    );
    const playerTabs = (): vscode.Tab[] =>
      vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.filter(
          (tab) =>
            tab.input instanceof vscode.TabInputWebview &&
            tab.input.viewType.endsWith('followalong.player'),
        ),
      );
    // The reload happened in the panel that was open, and was not a close (Player.onDidClose
    // would have unloaded the Lesson and its status bar items).
    assert.equal(playerTabs().length, 1, 'other folders opened a second player tab');
    assert.equal(hooks.statusBar().length, 4, 'the status bar items went when the page reloaded');
    say('other folders reload the page in the player panel that was open, without a close');
    if (reloaded !== 'played') {
      await aClickOnThePicture(hooks.playerEvents, code, lessons.warmUp);
    }
    const [playerBefore] = playerTabs();
    assert.ok(playerBefore, 'no player is open before the Course picker');

    const picksBefore = hooks.quickPicksShown();
    const picking = vscode.commands.executeCommand('followalong.openCourse');
    // The picker shows at once, from the cache or with the Recent Courses, and stops being busy
    // when the background scan is done and has filled in the list (#37).
    await waitFor('the Course picker to show', () =>
      hooks.quickPicksShown() > picksBefore && hooks.activeQuickPickItem() !== undefined
        ? true
        : undefined,
    );
    await waitFor('the Course picker to finish its scan', () =>
      hooks.quickPickBusy() ? undefined : true,
    );
    // Highlight “Picked Course” by moving down until it is the highlighted item, then accept it.
    await waitForAsync('“Picked Course” to be the highlighted item', async () => {
      if (hooks.activeQuickPickItem() === 'Picked Course') {
        return true;
      }
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      return undefined;
    });
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await waitFor('the picked Course to open', () =>
      hooks.lessonTree().nodes.some((node) => node.id === lessons.picked) ? true : undefined,
    );
    await picking;
    say('the Course picker lists the Courses under the Courses root, and picking one opens it');

    // Story 16 with #12 D3: the picked Course starts in the page that has the click.
    assert.equal(
      await lessonStartsOrIsRefused(hooks.playerEvents, lessons.picked),
      'played',
      'the picked Course did not start by itself: the player page lost the click',
    );
    // Story 20: opening a Course never touches the workspace folder.
    assert.deepEqual(
      vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath),
      workspaceBefore,
      'opening a Course changed the open folder',
    );
    // No close: the status bar items of a loaded Lesson stayed (Player.onDidClose unloads the
    // Lesson), and the one player tab is still in the editor group it was in.
    assert.equal(hooks.statusBar().length, 4, 'the status bar items went when the Course changed');
    const playerTabsAfter = playerTabs();
    assert.equal(playerTabsAfter.length, 1, 'another Course opened a second player tab');
    assert.equal(
      playerTabsAfter[0]?.group.viewColumn,
      playerBefore.group.viewColumn,
      'the player moved to another editor group',
    );
    say(
      'a Course picked under the same Courses root starts by itself in the same player page: no close, no new click',
    );
  } finally {
    await settings.update('coursesRoots', undefined, vscode.ConfigurationTarget.Global);
  }
}

/** Waits for the real page to play the Lesson or refuse its autoplay; fails on a player error. */
async function lessonStartsOrIsRefused(
  events: readonly SeenEvent[],
  lesson: string,
): Promise<'played' | 'refused'> {
  const outcome = await waitFor(`${lesson} to start or be refused`, () =>
    events.find(
      (event) =>
        event.lessonId === lesson &&
        (event.type === 'played' ||
          event.type === 'error' ||
          (event.type === 'paused' && event.byUser === false)),
    ),
  );
  assert.notEqual(outcome.type, 'error', `the player failed: ${outcome.message ?? ''}`);
  return outcome.type === 'played' ? 'played' : 'refused';
}

/**
 * While a Lesson is loaded the status bar has its four items, and each clickable one runs the
 * click command with the name of a core command. A click is what VS Code runs through the command
 * service, so the test runs the same command. What the items say at each state, and what each
 * core command does, is covered at Seam 1.
 */
async function theStatusBarRunsTheCommands(hooks: TestHooks): Promise<string> {
  const click = 'followalong.statusBarClick';
  const items = hooks.statusBar();
  assert.deepEqual(
    items.map(({ id, command }) => ({ id, command })),
    [
      { id: 'playPause', command: { id: click, argument: 'playPause' } },
      { id: 'time', command: undefined },
      { id: 'speed', command: { id: click, argument: 'speedCycle' } },
      { id: 'back', command: { id: click, argument: 'seekBackShort' } },
    ],
    'the status bar items of a loaded Lesson',
  );
  assert.ok(
    (await vscode.commands.getCommands(true)).includes(click),
    `${click} is not registered`,
  );

  // A click runs its command through VS Code. What the click does to the items is covered at
  // Seam 1; that the click really leaves the keyboard in the code needs a mouse (Manual QA).
  const code = vscode.window.activeTextEditor?.document;
  assert.ok(code, 'the code editor is not active');
  await vscode.commands.executeCommand(click, 'speedCycle');
  await vscode.commands.executeCommand('followalong.speedDown');
  assert.equal(vscode.window.activeTextEditor?.document, code, 'a click moved the focus');
  return 'the status bar shows play/pause, time, speed and back, each wired to the click command';
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
    // Another Course gets a new player panel; letting go of the old one is not a close, so the
    // status bar items stay (what the panel adapter must not fire `onDidClose` for).
    assert.equal(hooks.statusBar().length, 4, 'the status bar items went when the Course changed');

    // The "+" on the Lesson runs this command with the Lesson's tree node.
    const lesson = hooks.lessonTree().nodes.find((node) => node.id === 'lesson.webm');
    assert.ok(lesson, 'the scratch Course shows no Lesson lesson.webm');
    await vscode.commands.executeCommand(
      'followalong.attachResource',
      lesson,
      vscode.Uri.file(notes),
    );
    const shown = await waitFor(
      'the Resource under its Lesson',
      () => hooks.lessonTree().nodes.find((node) => node.id === lesson.id)?.resources?.[0],
    );

    const isPlayer = (tab: vscode.Tab): boolean =>
      tab.input instanceof vscode.TabInputWebview &&
      tab.input.viewType.endsWith('followalong.player');
    const groupHolding = (file: string): vscode.TabGroup | undefined =>
      vscode.window.tabGroups.all.find((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.fsPath === vscode.Uri.file(file).fsPath,
        ),
      );

    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('followalong.openResource', shown.id);
    const resourceGroup = await waitFor('the Resource tab', () => groupHolding(notes));
    const playerGroup = vscode.window.tabGroups.all.find((group) => group.tabs.some(isPlayer));
    assert.ok(playerGroup, 'opening the Resource closed the player');
    // Story 94: the Resource never covers the video, so both stay in sight.
    assert.notEqual(
      resourceGroup.viewColumn,
      playerGroup.viewColumn,
      'the file opened in the player’s editor group',
    );
    assert.notEqual(
      resourceGroup.viewColumn,
      vscode.ViewColumn.One,
      'the file opened over the code',
    );
    assert.ok(playerGroup.activeTab && isPlayer(playerGroup.activeTab), 'the player is covered');
    assert.equal(
      vscode.window.activeTextEditor?.document,
      code,
      'opening the Resource took the focus from the code',
    );

    // A second Resource goes to the same group, not to another new one.
    const more = join(scratch, 'more.ts');
    writeFileSync(more, 'export const more = 1;\n');
    await vscode.commands.executeCommand(
      'followalong.attachResource',
      lesson,
      vscode.Uri.file(more),
    );
    const second = await waitFor(
      'the second Resource under its Lesson',
      () => hooks.lessonTree().nodes.find((node) => node.id === lesson.id)?.resources?.[1],
    );
    await vscode.commands.executeCommand('followalong.openResource', second.id);
    const secondGroup = await waitFor('the second Resource tab', () => groupHolding(more));
    assert.equal(secondGroup.viewColumn, resourceGroup.viewColumn);
    assert.ok(!hooks.playerEvents.some((event) => event.type === 'error'));
  } finally {
    // Close the Resource tabs and the player, which hold the scratch files open: Windows refuses
    // to delete an open file (EPERM). The retries cover a handle VS Code lets go of a moment later.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

interface Contributes {
  readonly commands?: readonly { command?: string; title?: string; category?: string }[];
  readonly menus?: Readonly<Record<string, readonly { command?: string; when?: string }[]>>;
  readonly keybindings?: readonly {
    command?: string;
    key?: string;
    mac?: string;
    when?: string;
  }[];
}

/**
 * Stories 96 and 97: the Lesson tree's context menu offers Detach on every Resource and Relink… on
 * the missing ones (`contextValue` `resourceMissing`); neither is a Command Palette command, since
 * both need the Resource they were run on.
 */
function resourceMenusAreDeclared(packageJson: unknown): void {
  const { contributes } = packageJson as { contributes?: Contributes };
  const inTree = (command: string): (string | undefined)[] =>
    (contributes?.menus?.['view/item/context'] ?? [])
      .filter((entry) => entry.command === command)
      .map((entry) => entry.when);
  assert.deepEqual(inTree('followalong.detachResource'), [
    'view == followalong.lessons && viewItem =~ /^resource/',
  ]);
  assert.deepEqual(inTree('followalong.relinkResource'), [
    'view == followalong.lessons && viewItem == resourceMissing',
    'view == followalong.lessons && viewItem == resourceMissing',
  ]);
  for (const command of ['followalong.detachResource', 'followalong.relinkResource']) {
    assert.ok(
      (contributes?.menus?.commandPalette ?? []).some(
        (entry) => entry.command === command && entry.when === 'false',
      ),
      `${command} is not hidden from the Command Palette`,
    );
  }
}

/**
 * Stories 88 and 89: a Section's context menu offers Mark all done and Reset Section (neither is a
 * Command Palette command, since both need the Section they were run on); Reset Course progress
 * is a Command Palette command.
 */
function progressMenusAreDeclared(packageJson: unknown): void {
  const { contributes } = packageJson as { contributes?: Contributes };
  const palette = contributes?.menus?.commandPalette ?? [];
  for (const command of ['followalong.markSectionDone', 'followalong.resetSection']) {
    const inTree = (contributes?.menus?.['view/item/context'] ?? [])
      .filter((entry) => entry.command === command)
      .map((entry) => entry.when);
    assert.deepEqual(inTree, ['view == followalong.lessons && viewItem == section']);
    assert.ok(
      palette.some((entry) => entry.command === command && entry.when === 'false'),
      `${command} is not hidden from the Command Palette`,
    );
  }
  // Story 78: the toggle is a Command Palette command; a Lesson's context menu offers Mark done
  // and Mark not done.
  assert.ok(
    !palette.some((entry) => entry.command === 'followalong.toggleLessonDone'),
    'followalong.toggleLessonDone is hidden from the Command Palette',
  );
  for (const command of ['followalong.markLessonDone', 'followalong.markLessonNotDone']) {
    const inTree = (contributes?.menus?.['view/item/context'] ?? [])
      .filter((entry) => entry.command === command)
      .map((entry) => entry.when);
    assert.deepEqual(inTree, ['view == followalong.lessons && viewItem == lesson']);
    assert.ok(
      palette.some((entry) => entry.command === command && entry.when === 'false'),
      `${command} is not hidden from the Command Palette`,
    );
  }
  assert.ok(
    contributes?.commands?.some((entry) => entry.command === 'followalong.resetCourseProgress'),
    'followalong.resetCourseProgress is not declared',
  );
  assert.ok(
    !palette.some((entry) => entry.command === 'followalong.resetCourseProgress'),
    'followalong.resetCourseProgress is hidden from the Command Palette',
  );
}

/** Story 44: the learner controls the Lesson from the integrated terminal, so no key is editor-only. */
function everyKeyWorksInTheTerminal(packageJson: unknown): void {
  const { contributes } = packageJson as { contributes?: Contributes };
  const bindings = contributes?.keybindings ?? [];
  assert.ok(bindings.length > 0, 'the manifest has no keybindings');
  for (const { command, key, when } of bindings) {
    assert.ok(
      when?.includes('terminalFocus'),
      `${command ?? '?'} (${key ?? '?'}) is not bound while the terminal has focus`,
    );
  }
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

/** The step commands' Palette entries and keys, and the step settings VS Code reads from the manifest. */
function stepsAreBoundToTheirKeys(packageJson: unknown): void {
  const { contributes } = packageJson as { contributes?: Contributes };
  const steps = [
    ['seekBackShort', 'Back (Short Step)', ['ctrl+alt+left', "ctrl+' ,"]],
    ['seekForwardShort', 'Forward (Short Step)', ['ctrl+alt+right', "ctrl+' ."]],
    ['seekBackLong', 'Back (Long Step)', ["ctrl+' left"]],
    ['seekForwardLong', 'Forward (Long Step)', ["ctrl+' right"]],
  ] as const;
  for (const [name, title, keys] of steps) {
    const id = `followalong.${name}`;
    const command = contributes?.commands?.find((entry) => entry.command === id);
    assert.deepEqual(
      { title: command?.title, category: command?.category },
      { title, category: 'FollowAlong' },
      `the Command Palette entry is "FollowAlong: ${title}"`,
    );
    const bindings = (contributes?.keybindings ?? []).filter((entry) => entry.command === id);
    assert.deepEqual(
      bindings.map(({ key, when }) => ({ key, when })),
      keys.map((key) => ({ key, when: 'editorTextFocus || terminalFocus' })),
    );
  }
  // VS Code answers with the manifest's defaults until the learner changes a setting.
  const settings = vscode.workspace.getConfiguration('followalong');
  assert.equal(settings.get('shortStep'), 5, 'the short step defaults to 5 s');
  assert.equal(settings.get('longStep'), 30, 'the long step defaults to 30 s');
}

/** Each command has its `FollowAlong: <title>` Palette entry and exactly one chord key. */
function chordCommandsAreBound(
  packageJson: unknown,
  expected: readonly (readonly [name: string, title: string, key: string])[],
): void {
  const { contributes } = packageJson as { contributes?: Contributes };
  for (const [name, title, key] of expected) {
    const id = `followalong.${name}`;
    const command = contributes?.commands?.find((entry) => entry.command === id);
    assert.deepEqual(
      { title: command?.title, category: command?.category },
      { title, category: 'FollowAlong' },
      `the Command Palette entry is "FollowAlong: ${title}"`,
    );
    const bindings = (contributes?.keybindings ?? []).filter((entry) => entry.command === id);
    assert.deepEqual(
      bindings.map(({ key: bound, when }) => ({ key: bound, when })),
      [{ key, when: 'editorTextFocus || terminalFocus' }],
    );
  }
}

/** The Lesson picker: VS Code reads the manifest for the Command Palette entry and the chord. */
function goToLessonIsBoundToItsChord(packageJson: unknown): void {
  const { contributes } = packageJson as { contributes?: Contributes };
  const command = contributes?.commands?.find(
    (entry) => entry.command === 'followalong.goToLesson',
  );
  assert.deepEqual(
    { title: command?.title, category: command?.category },
    { title: 'Go to Lesson…', category: 'FollowAlong' },
    'the Command Palette entry is "FollowAlong: Go to Lesson…"',
  );
  const bindings = (contributes?.keybindings ?? []).filter(
    (entry) => entry.command === 'followalong.goToLesson',
  );
  assert.deepEqual(
    bindings.map(({ key, mac, when }) => ({ key, mac, when })),
    [{ key: "ctrl+' l", mac: "cmd+' l", when: 'editorTextFocus || terminalFocus' }],
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

  // A copy of the fixtures: FollowAlong writes its Course data into the Course it plays.
  const course = join(mkdtempSync(join(tmpdir(), 'followalong-smoke-course-')), 'media');
  cpSync(join(extensionPath, 'test', 'fixtures', 'media'), course, { recursive: true });
  await vscode.commands.executeCommand('followalong.openCourse', vscode.Uri.file(course));

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

/** The fixture Course's first Lesson, which the click and the commands after it act on. */
const lessonId = 'lesson.webm';

/**
 * Clicks the middle of the picture in the real player page, as the learner's mouse would, then
 * checks that the click played (or paused) the Lesson and that keyboard focus came back to the
 * code editor. A Lesson VS Code would not start by itself shows whether the click is a user
 * gesture (#12 D3).
 */
async function aClickOnThePicture(
  events: readonly SeenEvent[],
  code: vscode.TextDocument,
  clicked = lessonId,
): Promise<void> {
  const port = process.env.FOLLOWALONG_SMOKE_DEVTOOLS_PORT;
  assert.ok(port, 'scripts/run-smoke.mjs passes the DevTools port');
  const wasPlaying = lastPlayState(events, clicked) === 'played';
  // Keyboard focus in the player, where a learner's click leaves it. The click below comes from
  // the DevTools protocol, not from the OS, so it cannot be relied on to move VS Code's focus.
  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
  await waitFor('the player to have the focus', () =>
    vscode.window.activeTextEditor === undefined ? true : undefined,
  );
  const from = events.length;
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    await clickThePlayer(browser);
  } finally {
    // Only disconnects: for a DevTools connection Playwright closes its socket, not VS Code.
    await browser.close();
  }
  const expected = wasPlaying ? 'paused' : 'played';
  await waitFor(`the player to report ${expected} after the click`, () =>
    events
      .slice(from)
      .find(
        (event) =>
          event.lessonId === clicked &&
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
  say('with focus in the player, the click handed it back to the code editor in the Practice area');
}

/**
 * After the click, runs the play/pause command from the editor until it has to play, and checks
 * that the page then plays: one real click lets later commands start playback (sticky user
 * activation, ADR 0008), which #12 D3 relies on.
 */
async function playFromTheEditorAfterAClick(events: readonly SeenEvent[]): Promise<string> {
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
  // #12 D3 rests on this: one real click lets later commands start playback (sticky activation).
  assert.equal(
    answer.type,
    'played',
    'after one click in the player, play sent from the command was still refused',
  );
  return 'after one click in the player, play sent from the command starts playback (sticky activation)';
}

/**
 * Clicks the middle of the player's <iframe> in the VS Code window, with real input over the
 * DevTools protocol: the middle of the picture.
 */
async function clickThePlayer(browser: Browser): Promise<void> {
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
