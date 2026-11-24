/**
 * PROTOTYPE, throwaway (ticket "How does a YouTube Lesson feel in the player?"). Never merge.
 *
 * Plays a `youtube:<id>?relay=…&echo=…&focusReturn=…` Lesson in the player page: frames the relay
 * page (which embeds YouTube with the IFrame API), turns FollowAlong's player commands into relay
 * commands, and turns YouTube's state back into protocol events. In direct mode (`relay` empty)
 * YouTube is framed straight from the webview and nothing is controlled: it only shows what
 * YouTube does without a Referer.
 *
 * It also measures: the Referer the webview and the relay send (through the local `/echo`), and
 * when keyboard focus lands inside the YouTube frame, where VS Code forwards no keys. With
 * `focusReturn` on, the page then asks the extension to hand focus back (ADR 0009) after a grace
 * period.
 */
import type {
  AboutLesson,
  PlayerCommand,
  PlayerEvent,
  PlayerSnapshot,
} from '../protocol/player-messages.js';
import { wholePicture } from '../protocol/player-messages.js';

type Load = Extract<PlayerCommand, { type: 'load' }>;

/** What the relay posts (see media/prototype-youtube-relay.html). */
interface RelayMessage {
  readonly fa: 'yt';
  readonly ev: string;
  readonly time?: number;
  readonly duration?: number;
  readonly rate?: number;
  readonly state?: number;
  readonly rates?: readonly number[];
  readonly code?: number;
  readonly referrer?: string;
  readonly origin?: string;
}

function isRelayMessage(data: unknown): data is RelayMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'fa' in data &&
    data.fa === 'yt' &&
    'ev' in data &&
    typeof data.ev === 'string'
  );
}

const stateNames: Readonly<Record<number, string>> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

/** How long focus may sit in the YouTube frame before it is handed back, in ms. */
const focusGraceMs = 800;

/** How long the relay has to say it loaded before the page reports it silent, in ms. */
const relayWatchMs = 5000;

/** How far the playhead may stray from where it should be before it counts as a seek, in s. */
const seekJumpSeconds = 2;

export interface YouTubeLessonParts {
  readonly post: (event: PlayerEvent) => void;
  readonly log: (text: string) => void;
  readonly box: HTMLElement;
  readonly frame: HTMLIFrameElement;
  readonly diag: HTMLElement;
  readonly showNext: (title: string) => void;
  readonly hideNext: () => void;
}

export class YouTubeLesson {
  private about: AboutLesson | undefined;
  private videoId = '';
  private mode = '';
  private controlled = false;
  private focusReturn = true;
  private startSeekReported = false;
  private time = 0;
  private timeAt = 0;
  private duration = 0;
  private rate = 1;
  private wantedRate = 1;
  private state = -1;
  private playing = false;
  private ended = false;
  private pauseByExtension = false;
  private pendingSeek: number | undefined;
  private focusInFrame = false;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;
  private focusLosses = 0;
  private focusReturns = 0;
  private echoFrame: HTMLIFrameElement | undefined;
  /** Set until the relay says it loaded; a cross-origin frame that is blocked fires no error. */
  private relayWatch: ReturnType<typeof setTimeout> | undefined;
  private relayProblem = '';

  constructor(private readonly parts: YouTubeLessonParts) {
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (
        this.about !== undefined &&
        event.source === parts.frame.contentWindow &&
        isRelayMessage(event.data)
      ) {
        this.fromRelay(event.data);
      }
    });
    window.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.about !== undefined && document.activeElement === parts.frame) {
          this.focusEntered();
        }
      }, 0);
    });
    window.addEventListener('focus', () => {
      this.focusLeft();
    });
  }

  get active(): boolean {
    return this.about !== undefined;
  }

  load(command: Load): void {
    const uri = new URL(command.videoUri);
    const relay = uri.searchParams.get('relay') ?? '';
    const echo = uri.searchParams.get('echo') ?? '';
    this.about = {
      lessonId: command.lessonId,
      ...(command.loadId === undefined ? {} : { loadId: command.loadId }),
    };
    this.videoId = uri.pathname;
    this.controlled = relay !== '';
    this.mode = relay === '' ? 'direct' : relay.startsWith('http://127.0.0.1') ? 'local' : 'https';
    this.focusReturn = uri.searchParams.get('focusReturn') !== '0';
    this.startSeekReported = command.startAt === 0;
    this.time = command.startAt;
    this.timeAt = performance.now();
    this.duration = 0;
    this.state = -1;
    this.playing = false;
    this.ended = false;
    this.pauseByExtension = false;
    this.pendingSeek = undefined;
    document.body.classList.add('prototype-youtube-on');
    this.parts.box.removeAttribute('hidden');
    this.parts.diag.removeAttribute('hidden');
    const start = String(Math.floor(command.startAt));
    const autoplay = command.autoplay ? '1' : '0';
    if (this.controlled) {
      const query = new URLSearchParams({
        v: this.videoId,
        start,
        autoplay,
        echo: `${echo}?from=relay-${this.mode}`,
      });
      this.parts.frame.src = `${relay}?${query.toString()}`;
      clearTimeout(this.relayWatch);
      this.relayProblem = '';
      this.relayWatch = setTimeout(() => {
        this.relayProblem = 'RELAY SILENT: blocked? (Local Network Access, CSP, offline)';
        this.parts.log(
          `the relay at ${relay} did not answer in ${String(relayWatchMs)} ms: blocked by Chromium's Local Network Access checks, the CSP, or the network?`,
        );
        this.render();
      }, relayWatchMs);
    } else {
      const query = new URLSearchParams({ enablejsapi: '1', start, autoplay, rel: '0' });
      this.parts.frame.src = `https://www.youtube-nocookie.com/embed/${this.videoId}?${query.toString()}`;
    }
    // The Referer the webview itself sends to a frame (the research read it only from source).
    this.echoFrame?.remove();
    const probe = document.createElement('iframe');
    probe.hidden = true;
    probe.src = `${echo}?from=webview`;
    document.body.append(probe);
    this.echoFrame = probe;
    this.parts.log(
      `load ${this.videoId} mode=${this.mode} startAt=${start} autoplay=${autoplay} focusReturn=${String(this.focusReturn)}`,
    );
    this.render();
  }

  unload(): void {
    if (this.about === undefined) {
      return;
    }
    this.about = undefined;
    clearTimeout(this.relayWatch);
    this.parts.frame.src = 'about:blank';
    this.parts.box.setAttribute('hidden', '');
    this.parts.diag.setAttribute('hidden', '');
    document.body.classList.remove('prototype-youtube-on');
  }

  run(command: PlayerCommand): void {
    switch (command.type) {
      case 'play':
        this.pauseByExtension = false;
        this.parts.log(`play asked (state ${this.stateName()})`);
        this.send({ cmd: 'play' });
        break;
      case 'pause':
        if (this.playing) {
          this.pauseByExtension = true;
        }
        this.send({ cmd: 'pause' });
        break;
      case 'seekBy': {
        const end = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY;
        const from = this.pendingSeek ?? this.now();
        const target = Math.min(Math.max(from + command.seconds, 0), end);
        this.pendingSeek = target;
        this.parts.hideNext();
        this.send({ cmd: 'seekTo', time: target });
        break;
      }
      case 'setRate':
        this.wantedRate = command.rate;
        this.send({ cmd: 'setRate', rate: command.rate });
        break;
      case 'showNext':
        if (this.ended) {
          this.parts.showNext(command.title);
        }
        break;
      default:
        // Resume rewind, sound, zoom and restore have no YouTube counterpart in the spike.
        break;
    }
  }

  snapshot(): PlayerSnapshot {
    const page = { rate: this.rate, zoom: wholePicture };
    if (this.about === undefined) {
      return page;
    }
    return { ...page, lesson: { ...this.about, position: this.now(), playing: this.playing } };
  }

  /** Where the playhead is now, from the last report and the time since. */
  private now(): number {
    if (!this.playing) {
      return this.time;
    }
    return this.time + ((performance.now() - this.timeAt) / 1000) * this.rate;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.controlled) {
      this.parts.log(`direct mode: ${String(message.cmd)} not sent (no API)`);
      return;
    }
    this.parts.frame.contentWindow?.postMessage({ fa: 'yt', ...message }, '*');
  }

  private fromRelay(message: RelayMessage): void {
    const about = this.about;
    if (about === undefined) {
      return;
    }
    switch (message.ev) {
      case 'relayLoaded':
        clearTimeout(this.relayWatch);
        this.relayProblem = '';
        this.parts.log(
          `relay at ${message.origin ?? '?'} sees document.referrer="${message.referrer ?? ''}"`,
        );
        break;
      case 'ready':
        this.parts.log(`YouTube ready; rates ${JSON.stringify(message.rates ?? [])}`);
        this.track(message);
        if (this.wantedRate !== 1) {
          this.send({ cmd: 'setRate', rate: this.wantedRate });
        }
        if (!this.startSeekReported) {
          this.startSeekReported = true;
          this.parts.post({ type: 'seeked', ...about, startSeek: true });
        }
        break;
      case 'tick':
        this.track(message);
        break;
      case 'state':
        this.track(message);
        this.stateChanged(about, message.state ?? -1);
        break;
      case 'rate':
        if (message.rate !== undefined && message.rate !== this.rate) {
          this.rate = message.rate;
          this.parts.post({ type: 'rateChanged', ...about, rate: message.rate });
        }
        break;
      case 'error':
        this.parts.log(`YouTube error ${String(message.code)}`);
        this.parts.post({
          type: 'error',
          ...about,
          message: `YouTube error ${String(message.code)}`,
        });
        break;
      case 'autoplayBlocked':
        this.parts.log('YouTube: autoplay blocked');
        this.parts.post({ type: 'paused', ...about, byUser: false });
        break;
      case 'focusInYouTube':
        this.parts.log('relay: focus went into the YouTube frame');
        break;
    }
    this.render();
  }

  /** Takes the playhead from a relay report, and reports it, or a seek, to the extension. */
  private track(message: RelayMessage): void {
    const about = this.about;
    if (about === undefined || message.time === undefined) {
      return;
    }
    const expected = this.now();
    this.time = message.time;
    this.timeAt = performance.now();
    if (message.duration !== undefined && message.duration > 0) {
      this.duration = message.duration;
    }
    if (message.rate !== undefined && message.rate !== this.rate) {
      this.rate = message.rate;
      this.parts.post({ type: 'rateChanged', ...about, rate: message.rate });
    }
    if (this.pendingSeek !== undefined) {
      if (Math.abs(message.time - this.pendingSeek) < seekJumpSeconds) {
        this.pendingSeek = undefined;
        this.parts.post({ type: 'seeked', ...about, startSeek: false });
      }
    } else if (this.startSeekReported && Math.abs(message.time - expected) > seekJumpSeconds) {
      // A jump nobody here asked for: the learner's seek on YouTube's own seek bar.
      this.parts.log(`seek in YouTube's bar: ${expected.toFixed(1)} → ${message.time.toFixed(1)}`);
      this.parts.post({ type: 'seeked', ...about, startSeek: false });
    }
    this.parts.post({
      type: 'timeUpdate',
      ...about,
      position: message.time,
      duration: this.duration,
    });
  }

  private stateChanged(about: AboutLesson, state: number): void {
    this.state = state;
    if (state === 1) {
      this.ended = false;
      this.parts.hideNext();
      if (!this.playing) {
        this.playing = true;
        this.parts.post({ type: 'played', ...about });
      }
    } else if (state === 2 && this.playing) {
      this.playing = false;
      this.parts.post({ type: 'paused', ...about, byUser: !this.pauseByExtension });
      this.pauseByExtension = false;
    } else if (state === 0) {
      this.playing = false;
      this.ended = true;
      this.parts.post({ type: 'ended', ...about });
    }
  }

  private focusEntered(): void {
    if (this.focusInFrame) {
      return;
    }
    this.focusInFrame = true;
    this.focusLosses += 1;
    this.parts.log(`focus went into the YouTube frame (#${String(this.focusLosses)}): keys dead`);
    if (this.focusReturn) {
      clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => {
        if (this.focusInFrame) {
          this.focusReturns += 1;
          this.parts.log('focus return asked (ADR 0009)');
          this.parts.post({ type: 'userInteracted' });
        }
      }, focusGraceMs);
    }
    this.render();
  }

  private focusLeft(): void {
    clearTimeout(this.focusTimer);
    if (this.focusInFrame) {
      this.focusInFrame = false;
      this.render();
    }
  }

  private stateName(): string {
    return stateNames[this.state] ?? String(this.state);
  }

  private render(): void {
    const { diag } = this.parts;
    const focus = this.focusInFrame
      ? 'FOCUS IN YOUTUBE: keys dead'
      : `focus ok (lost ${String(this.focusLosses)}×, returned ${String(this.focusReturns)}×)`;
    const problem = this.relayProblem === '' ? '' : ` · ${this.relayProblem}`;
    diag.textContent = `PROTOTYPE · ${this.videoId} · ${this.mode}${problem} · ${this.stateName()} ${this.now().toFixed(1)}/${this.duration.toFixed(0)}s ×${String(this.rate)} · ${focus}`;
    diag.classList.toggle('stuck', this.focusInFrame || this.relayProblem !== '');
  }
}
