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
  goToLessonIsBoundToItsChord(extension.packageJSON);
  say("FollowAlong: Go to Lesson… is in the Command Palette and bound to Ctrl+' L");

  chordCommandsAreBound(extension.packageJSON, [
    ['speedUp', 'Speed up', "ctrl+' up"],
    ['speedDown', 'Speed down', "ctrl+' down"],
  ]);
  say("FollowAlong: Speed up / Speed down are in the Command Palette, bound to Ctrl+' ↑ / ↓");

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

  await opensACourseBesideTheCode(extension.extensionPath);
  say('a Course opens in an editor group beside the code, and the open folder is unchanged');

  say(await theLessonStarts(hooks.playerEvents, 'lesson.webm'));
  say(await playFromTheEditor(hooks.playerEvents));

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

  await aResourceOpensBesideTheCode(extension.extensionPath, hooks);
  say('a file attached to a Lesson shows under it and opens beside the code, next to the player');

  await resourcesOpenByType(extension.extensionPath, hooks);
  say('Markdown, HTML, an image and a PDF each open in their own kind of tab beside the code');
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

    const code = await vscode.workspace.openTextDocument({
      language: 'javascript',
      content: '1;\n',
    });
    await vscode.window.showTextDocument(code, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('followalong.openCourse', vscode.Uri.file(course));
    const lesson = await waitFor('the scratch Course in the tree', () =>
      hooks.lessonTree().nodes.find((node) => node.id === 'lesson.webm'),
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
        ? tab.input.viewType.replace(/^.*-/, '')
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
    const kinds: string[] = [];
    for (const [label] of expectations) {
      const tab = await waitFor(`the tab ${label}`, () => tabFor(label));
      opened.push(tab);
      kinds.push(kindOf(tab));
    }
    assert.deepEqual(
      kinds,
      expectations.map(([, kind]) => kind),
      'the tab each Resource opened as',
    );

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

    // Let go of the Resource tabs before their files go.
    await vscode.window.tabGroups.close(opened);
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
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
    rmSync(scratch, { recursive: true, force: true });
  }
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
