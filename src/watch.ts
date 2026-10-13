/**
 * WatchManager — the part of screen-mcpl that turns Peekaboo's kept frames
 * into a small number of well-timed push events.
 *
 * Each watch owns a chain of ≤180 s `capture live` segments (Peekaboo's hard
 * cap), restarted back-to-back. Kept frames are coalesced: a burst of changes
 * becomes ONE push once the screen has been quiet for `coalesceSeconds`, or at
 * the latest after `maxHoldSeconds` of continuous activity. The push carries
 * the last frame of the burst (motion boxes highlighted when enabled).
 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  startLive as realStartLive, describeTarget, type KeptFrame, type LiveOutcome, type LiveSession,
  type PbError, type StartLive, type Target,
} from './peekaboo.js';
import { renderFrame as realRenderFrame, type RenderFrame } from './image.js';

export type ImageMode = 'inline' | 'path' | 'none';

export interface WatchSpec {
  id: string;
  label: string;
  /** Why the agent is watching — echoed on every push so the wake is self-explaining. */
  note?: string;
  target: Target;
  threshold: number;
  coalesceSeconds: number;
  maxHoldSeconds: number;
  minIntervalSeconds: number;
  image: ImageMode;
  highlight: boolean;
  maxPx: number;
  paused: boolean;
  createdAt: number;
}

export type WatchState = 'starting' | 'watching' | 'waiting' | 'blocked' | 'paused' | 'stopped';

export interface WatchRuntime {
  state: WatchState;
  reason?: string;
  segment: number;
  /** Kept frames that were real changes (baselines excluded). */
  changes: number;
  pushes: number;
  startedAt: number;
  lastFrameAt?: number;
  lastChangeAt?: number;
  lastPushAt?: number;
  lastSegmentStats?: string;
}

export interface Burst {
  frames: KeptFrame[];
  firstAt: number;
  lastAt: number;
  /** JPEG of the last frame, when image mode != 'none'. */
  imagePath?: string;
  /** From the diff against the previous pushed frame (framebox), when available. */
  boxes?: number;
  changePercent?: number;
  pushNumber: number;
}

export interface WatchSink {
  /** Deliver a burst. Return true if it went out. */
  push(spec: WatchSpec, rt: WatchRuntime, burst: Burst): Promise<boolean>;
  /** A watch moved between states while running (e.g. app quit). */
  stateChanged(spec: WatchSpec, rt: WatchRuntime, prev: WatchState): void;
  log(...a: unknown[]): void;
}

export interface WatchDeps {
  startLive?: StartLive;
  renderFrame?: RenderFrame;
  segmentSeconds?: number;
  idleFps?: number;
  activeFps?: number;
  resolutionCap?: number;
  maxFrames?: number;
}

interface Live {
  spec: WatchSpec;
  rt: WatchRuntime;
  dir: string;
  session?: LiveSession;
  pending: KeptFrame[];
  holdStart?: number;
  quietTimer?: ReturnType<typeof setTimeout>;
  flushTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  backoffMs: number;
  stopped: boolean;
  /** Copy of the last pushed frame (or the first baseline): what the next push is diffed against. */
  referencePath?: string;
  /** Resolved by the first baseline frame or the first error of the first segment. */
  firstOutcome?: { resolve: (r: FirstOutcome) => void; settled: boolean };
}

export type FirstOutcome = { ok: true } | { ok: false; state: WatchState; reason: string };

const SEGMENT_DIRS_TO_KEEP = 2;
const PUSHED_IMAGES_TO_KEEP = 30;

export class WatchManager {
  private live = new Map<string, Live>();
  private readonly startLive: StartLive;
  private readonly renderFrame: RenderFrame;
  private readonly segmentSeconds: number;

  constructor(private readonly root: string, private readonly sink: WatchSink, private readonly deps: WatchDeps = {}) {
    this.startLive = deps.startLive ?? realStartLive;
    this.renderFrame = deps.renderFrame ?? realRenderFrame;
    this.segmentSeconds = deps.segmentSeconds ?? 180;
  }

  list(): Array<{ spec: WatchSpec; rt: WatchRuntime }> {
    return [...this.live.values()].map(l => ({ spec: l.spec, rt: l.rt }));
  }

  get(id: string): { spec: WatchSpec; rt: WatchRuntime } | undefined {
    const l = this.live.get(id);
    return l && { spec: l.spec, rt: l.rt };
  }

  /** Start (or resume after restart) a watch. Resolves with the first segment's
   *  first outcome — baseline captured, or why not — within `waitMs`. */
  async start(spec: WatchSpec, waitMs = 8000): Promise<FirstOutcome | { ok: true; pending: true }> {
    this.stopInternal(spec.id, false);
    const l: Live = {
      spec, dir: join(this.root, spec.id), pending: [], backoffMs: 10_000, stopped: false,
      rt: { state: spec.paused ? 'paused' : 'starting', segment: 0, changes: 0, pushes: 0, startedAt: Date.now() },
    };
    this.live.set(spec.id, l);
    await mkdir(join(l.dir, 'pushed'), { recursive: true });
    if (spec.paused) return { ok: true };
    const first = new Promise<FirstOutcome>((resolve) => { l.firstOutcome = { resolve, settled: false }; });
    void this.runSegment(l);
    const timeout = new Promise<{ ok: true; pending: true }>((resolve) => setTimeout(() => resolve({ ok: true, pending: true }), waitMs).unref());
    return Promise.race([first, timeout]);
  }

  stop(id: string): boolean { return this.stopInternal(id, true); }

  /** Apply spec changes in place. Pausing kills the capture; resuming restarts it. */
  update(id: string, patch: Partial<WatchSpec>): WatchSpec | undefined {
    const l = this.live.get(id);
    if (!l) return undefined;
    const wasPaused = l.spec.paused;
    Object.assign(l.spec, patch);
    if (l.spec.paused && !wasPaused) {
      this.clearTimers(l);
      l.session?.stop();
      l.pending = [];
      this.setState(l, 'paused', undefined, false);
    } else if (!l.spec.paused && wasPaused) {
      this.setState(l, 'starting', undefined, false);
      void this.runSegment(l);
    }
    return l.spec;
  }

  stopAll(): void { for (const id of [...this.live.keys()]) this.stopInternal(id, true); }

  private stopInternal(id: string, remove: boolean): boolean {
    const l = this.live.get(id);
    if (!l) return false;
    l.stopped = true;
    this.clearTimers(l);
    l.session?.stop();
    l.rt.state = 'stopped';
    if (remove) this.live.delete(id);
    return true;
  }

  private clearTimers(l: Live): void {
    for (const k of ['quietTimer', 'flushTimer', 'retryTimer'] as const) {
      if (l[k]) { clearTimeout(l[k]); l[k] = undefined; }
    }
  }

  private setState(l: Live, state: WatchState, reason: string | undefined, notify: boolean): void {
    const prev = l.rt.state;
    l.rt.state = state;
    l.rt.reason = reason;
    if (notify && prev !== state) this.sink.stateChanged(l.spec, l.rt, prev);
  }

  private settleFirst(l: Live, r: FirstOutcome): void {
    if (l.firstOutcome && !l.firstOutcome.settled) { l.firstOutcome.settled = true; l.firstOutcome.resolve(r); }
  }

  // ── Segment chain ──

  private async runSegment(l: Live): Promise<void> {
    if (l.stopped || l.spec.paused) return;
    l.rt.segment += 1;
    // Unique per process lifetime AND per restart: a resumed watch must never
    // reuse a directory (Peekaboo refuses non-empty dirs, and the poller would
    // mistake old frames for new changes). Timestamp-first keeps sort order
    // chronological for pruning.
    const segDir = join(l.dir, `seg-${Date.now()}-${String(l.rt.segment).padStart(4, '0')}`);
    await rm(segDir, { recursive: true, force: true });
    await mkdir(segDir, { recursive: true });
    let baselineSeen = false;
    const session = this.startLive({
      target: l.spec.target, dir: segDir, threshold: l.spec.threshold, highlight: l.spec.highlight,
      durationSeconds: this.segmentSeconds,
      idleFps: this.deps.idleFps ?? 1, activeFps: this.deps.activeFps ?? 4,
      resolutionCap: this.deps.resolutionCap ?? 1440, maxFrames: this.deps.maxFrames ?? 800,
    }, (frame) => {
      if (l.stopped) return;
      l.rt.lastFrameAt = frame.at;
      if (!baselineSeen) {
        // Peekaboo keeps frame 1 of every session unconditionally (100% change
        // vs. nothing). It proves capture works; it is not a change.
        baselineSeen = true;
        l.backoffMs = 10_000;
        if (!l.referencePath) void this.setReference(l, frame.path);
        if (l.rt.state !== 'watching') this.setState(l, 'watching', undefined, true);
        this.settleFirst(l, { ok: true });
        return;
      }
      this.onChange(l, frame);
    });
    l.session = session;
    const outcome = await session.done;
    l.session = undefined;
    void this.pruneSegments(l);
    if (l.stopped || l.spec.paused) return;
    if (outcome.ok) {
      if (outcome.stats) l.rt.lastSegmentStats = summarizeStats(outcome);
      // Back-to-back: the gap between segments (~0.5 s) is the only blind spot.
      setImmediate(() => void this.runSegment(l));
      return;
    }
    this.onSegmentError(l, outcome.error ?? { message: 'unknown capture failure' });
  }

  private onSegmentError(l: Live, error: PbError): void {
    const { state, reason, retryMs } = classify(error, l.spec.target, l.backoffMs);
    this.sink.log(`watch ${l.spec.id}: ${state} — ${reason}; retry in ${Math.round(retryMs / 1000)}s`);
    this.setState(l, state, reason, true);
    this.settleFirst(l, { ok: false, state, reason });
    l.backoffMs = Math.min(l.backoffMs * 2, 5 * 60_000);
    l.retryTimer = setTimeout(() => { l.retryTimer = undefined; void this.runSegment(l); }, retryMs);
    l.retryTimer.unref?.();
  }

  private async pruneSegments(l: Live): Promise<void> {
    try {
      const names = (await readdir(l.dir)).filter(n => n.startsWith('seg-')).sort();
      for (const n of names.slice(0, Math.max(0, names.length - SEGMENT_DIRS_TO_KEEP))) {
        await rm(join(l.dir, n), { recursive: true, force: true });
      }
      const pushed = (await readdir(join(l.dir, 'pushed'))).filter(n => n.endsWith('.jpg')).sort();
      for (const n of pushed.slice(0, Math.max(0, pushed.length - PUSHED_IMAGES_TO_KEEP))) {
        await rm(join(l.dir, 'pushed', n), { force: true });
      }
    } catch (e) { this.sink.log(`prune failed for ${l.spec.id}:`, (e as Error).message); }
  }

  // ── Coalescing ──

  private onChange(l: Live, frame: KeptFrame): void {
    l.rt.changes += 1;
    l.rt.lastChangeAt = frame.at;
    l.pending.push(frame);
    l.holdStart ??= frame.at;
    if (l.quietTimer) clearTimeout(l.quietTimer);
    const heldMs = frame.at - l.holdStart;
    if (heldMs >= l.spec.maxHoldSeconds * 1000) { this.scheduleFlush(l, 0); return; }
    const quietMs = l.spec.coalesceSeconds * 1000;
    const remainingHold = l.spec.maxHoldSeconds * 1000 - heldMs;
    l.quietTimer = setTimeout(() => { l.quietTimer = undefined; this.scheduleFlush(l, 0); }, Math.min(quietMs, remainingHold));
  }

  /** Flush honouring minIntervalSeconds: if the last push was too recent, wait
   *  out the remainder (new frames keep merging into the same burst). */
  private scheduleFlush(l: Live, delayMs: number): void {
    if (l.flushTimer) return; // already scheduled; frames keep accumulating
    const since = l.rt.lastPushAt ? Date.now() - l.rt.lastPushAt : Infinity;
    const minMs = l.spec.minIntervalSeconds * 1000;
    const wait = Math.max(delayMs, since < minMs ? minMs - since : 0);
    l.flushTimer = setTimeout(() => { l.flushTimer = undefined; void this.flush(l); }, wait);
  }

  private async flush(l: Live): Promise<void> {
    if (l.stopped || l.pending.length === 0) return;
    const frames = l.pending;
    l.pending = [];
    l.holdStart = undefined;
    if (l.quietTimer) { clearTimeout(l.quietTimer); l.quietTimer = undefined; }
    const last = frames[frames.length - 1];
    const pushNumber = l.rt.pushes + 1;
    let imagePath: string | undefined;
    let boxes: number | undefined;
    let changePercent: number | undefined;
    if (l.spec.image !== 'none') {
      // Timestamp-named so files never collide across server restarts (the push
      // counter is per process) and sort chronologically for pruning.
      const out = join(l.dir, 'pushed', `push-${new Date(last.at).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}.jpg`);
      try {
        const r = await this.renderFrame(last.path, out, l.spec.maxPx, l.referencePath, l.spec.highlight);
        imagePath = r.path; boxes = r.boxes; changePercent = r.changePercent;
      } catch (e) { this.sink.log(`render failed for ${l.spec.id}:`, (e as Error).message); imagePath = last.path; }
    }
    await this.setReference(l, last.path);
    const sent = await this.sink.push(l.spec, l.rt, { frames, firstAt: frames[0].at, lastAt: last.at, imagePath, boxes, changePercent, pushNumber });
    if (sent) { l.rt.pushes = pushNumber; l.rt.lastPushAt = Date.now(); }
  }

  /** Keep our own copy: segment directories get pruned, the reference must not. */
  private async setReference(l: Live, framePath: string): Promise<void> {
    const ref = join(l.dir, 'reference.png');
    try { await copyFile(framePath, ref); l.referencePath = ref; }
    catch (e) { this.sink.log(`reference copy failed for ${l.spec.id}:`, (e as Error).message); }
  }
}

function summarizeStats(o: LiveOutcome): string {
  const s = o.stats ?? {};
  return `kept ${s.framesKept ?? '?'} of ${s.framesSampled ?? '?'} sampled, ${s.captureFailures ?? 0} failures`;
}

/** Map a Peekaboo failure to a watch state + retry cadence. */
export function classify(error: PbError, target: Target, backoffMs: number): { state: WatchState; reason: string; retryMs: number } {
  const code = (error.code ?? '').toUpperCase();
  const msg = (error.message ?? '').toLowerCase();
  const what = describeTarget(target);
  if (code === 'PEEKABOO_MISSING') return { state: 'blocked', reason: error.message ?? 'peekaboo missing', retryMs: 5 * 60_000 };
  if (code.includes('ACCESSIBILITY') || /listwindows|accessibility/i.test(msg)) {
    return { state: 'blocked', reason: `app/window targets need Accessibility (System Settings › Privacy & Security › Accessibility › Terminal); screen/region targets work with Screen Recording alone`, retryMs: 60_000 };
  }
  if (code.includes('PERMISSION')) return { state: 'blocked', reason: `${error.message ?? 'permission denied'} — grant it to Terminal in System Settings › Privacy & Security`, retryMs: 60_000 };
  if (msg.includes('locked')) return { state: 'blocked', reason: 'the macOS session is locked; capture resumes when it is unlocked', retryMs: 60_000 };
  const clean = (error.message ?? code ?? 'unknown').replace(/\.\s*$/, '');
  if (code.includes('NOT_FOUND') || code.includes('NOT_RUNNING') || /not (found|running)|no (eligible )?window|could not find|no matching|not visible/.test(msg)) {
    return { state: 'waiting', reason: `${what} is not available right now (${clean}); watching for it to appear`, retryMs: 20_000 };
  }
  return { state: 'blocked', reason: `capture failed: ${clean}`, retryMs: backoffMs };
}
