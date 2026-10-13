/**
 * Thin wrapper over the Peekaboo CLI (https://github.com/openclaw/Peekaboo).
 *
 * Everything screen-mcpl knows about the screen comes through here: one-shot
 * JSON commands (`pb`) and the long-running `capture live` session
 * (`startLive`) whose kept frames we pick up from disk as they land.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const execFileP = promisify(execFile);

export const PEEKABOO_BIN = process.env.PEEKABOO_BIN ?? 'peekaboo';

export interface PbError { code?: string; message?: string; details?: string }
export interface PbResult<T = unknown> { success: boolean; data?: T; error?: PbError }

function parseJson(s: string): PbResult {
  const t = s.trim();
  const i = t.indexOf('{');
  return JSON.parse(i >= 0 ? t.slice(i) : t) as PbResult;
}

/** Run a one-shot peekaboo command with --json and return its parsed envelope.
 *  Never throws: every failure mode becomes `{ success:false, error }`. */
export async function pb<T = unknown>(args: string[], opts: { timeoutMs?: number } = {}): Promise<PbResult<T>> {
  try {
    const { stdout } = await execFileP(PEEKABOO_BIN, [...args, '--json'], {
      timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024,
    });
    return parseJson(stdout) as PbResult<T>;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.stdout) { try { return parseJson(err.stdout) as PbResult<T>; } catch { /* fall through */ } }
    if (err.code === 'ENOENT') return { success: false, error: { code: 'PEEKABOO_MISSING', message: `peekaboo binary not found (${PEEKABOO_BIN}). Install: brew install openclaw/tap/peekaboo` } };
    if (err.killed) return { success: false, error: { code: 'TIMEOUT', message: `peekaboo ${args[0]} timed out` } };
    return { success: false, error: { code: 'EXEC', message: (err.stderr ?? '').trim() || err.message } };
  }
}

export function errorText(r: PbResult): string {
  const e = r.error ?? {};
  return [e.message, e.details && e.details !== e.message ? `(${e.details})` : '', e.code ? `[${e.code}]` : ''].filter(Boolean).join(' ');
}

// ── Permissions ──

export interface Permissions { screenRecording: boolean; accessibility: boolean; error?: string }

export async function permissions(): Promise<Permissions> {
  const r = await pb<{ permissions?: Array<{ name: string; isGranted: boolean }> }>(['permissions'], { timeoutMs: 15_000 });
  if (!r.success) return { screenRecording: false, accessibility: false, error: errorText(r) };
  const has = (n: string) => r.data?.permissions?.find(p => p.name.toLowerCase().includes(n))?.isGranted === true;
  return { screenRecording: has('screen'), accessibility: has('accessibility') };
}

// ── Targets ──

/** What to point the camera at. Exactly one of region / app / (nothing = whole screen). */
export interface Target {
  app?: string;
  windowTitle?: string;
  windowIndex?: number;
  screenIndex?: number;
  /** "x,y,width,height" in global display points. */
  region?: string;
}

export function describeTarget(t: Target): string {
  if (t.region) return `region ${t.region}`;
  if (t.app) {
    const w = t.windowTitle ? ` window "${t.windowTitle}"` : t.windowIndex != null ? ` window #${t.windowIndex}` : '';
    return `${t.app}${w}`;
  }
  return t.screenIndex != null ? `screen ${t.screenIndex}` : 'main screen';
}

export function targetArgs(t: Target): string[] {
  if (t.region) return ['--mode', 'area', '--region', t.region];
  if (t.app) {
    const a = ['--app', t.app, '--mode', 'window'];
    if (t.windowTitle) a.push('--window-title', t.windowTitle);
    if (t.windowIndex != null) a.push('--window-index', String(t.windowIndex));
    return a;
  }
  const a = ['--mode', 'screen'];
  if (t.screenIndex != null) a.push('--screen-index', String(t.screenIndex));
  return a;
}

// ── Live capture ──

export interface LiveOptions {
  target: Target;
  dir: string;
  /** Whole-frame change percent that counts as a change (Peekaboo --threshold). */
  threshold: number;
  highlight: boolean;
  durationSeconds: number;
  idleFps: number;
  activeFps: number;
  resolutionCap: number;
  maxFrames: number;
}

export interface KeptFrame { index: number; path: string; at: number }

export interface LiveFrameInfo { index: number; file: string; timestampMs: number; changePercent: number; reason: string }
export interface LiveStats { framesKept?: number; framesSampled?: number; framesDiffFiltered?: number; captureFailures?: number }
export interface LiveOutcome {
  ok: boolean;
  error?: PbError;
  stats?: LiveStats;
  frames?: LiveFrameInfo[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface LiveSession {
  /** Resolves when the capture process has exited and the last frames were collected. */
  done: Promise<LiveOutcome>;
  stop(): void;
  pid: number | undefined;
}

export type StartLive = (o: LiveOptions, onFrame: (f: KeptFrame) => void) => LiveSession;

const KEEP_RE = /^keep-(\d{4})\.png$/;

/**
 * Spawn `peekaboo capture live` into `o.dir` and hand each kept frame to
 * `onFrame` as soon as its file has stopped growing. Frame 1 of every session
 * is Peekaboo's forced baseline (100% change by definition) — the caller
 * decides what to do with it.
 */
export const startLive: StartLive = (o, onFrame) => {
  const args = [
    'capture', 'live', ...targetArgs(o.target),
    '--path', o.dir,
    '--duration', `${o.durationSeconds}s`,
    '--threshold', String(o.threshold),
    '--heartbeat', '0',
    '--idle-fps', String(o.idleFps),
    '--active-fps', String(o.activeFps),
    '--resolution-cap', String(o.resolutionCap),
    '--max-frames', String(o.maxFrames),
    '--capture-focus', 'background',
    ...(o.highlight ? ['--highlight-changes'] : []),
    '--json',
  ];
  let child: ChildProcess;
  try {
    child = spawn(PEEKABOO_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as Error;
    return { pid: undefined, stop() {}, done: Promise.resolve({ ok: false, error: { code: 'SPAWN', message: err.message }, exitCode: null, signal: null }) };
  }
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 64_000) stderr = stderr.slice(-32_000); });

  // Frames appear as keep-NNNN.png; a frame is ready once its size is stable
  // across two polls (Peekaboo writes the PNG in one go, so this is cheap
  // insurance rather than a real race).
  const seen = new Set<number>();
  const sizes = new Map<number, number>();
  let polling = true;
  const sweep = async (final: boolean) => {
    let names: string[];
    try { names = await readdir(o.dir); } catch { return; }
    for (const name of names) {
      const m = KEEP_RE.exec(name);
      if (!m) continue;
      const index = Number(m[1]);
      if (seen.has(index)) continue;
      const p = join(o.dir, name);
      let size: number;
      try { size = (await stat(p)).size; } catch { continue; }
      if (size > 0 && (final || sizes.get(index) === size)) {
        seen.add(index);
        sizes.delete(index);
        onFrame({ index, path: p, at: Date.now() });
      } else {
        sizes.set(index, size);
      }
    }
  };
  const timer = setInterval(() => { if (polling) void sweep(false); }, 250);

  const done = new Promise<LiveOutcome>((resolve) => {
    const finish = async (exitCode: number | null, signal: NodeJS.Signals | null, spawnErr?: Error) => {
      polling = false;
      clearInterval(timer);
      await sweep(true);
      let parsed: PbResult<{ stats?: LiveStats; frames?: LiveFrameInfo[] }> | undefined;
      try { parsed = parseJson(stdout) as typeof parsed; } catch { /* no JSON: crashed or killed */ }
      if (spawnErr) {
        const code = (spawnErr as NodeJS.ErrnoException).code === 'ENOENT' ? 'PEEKABOO_MISSING' : 'SPAWN';
        resolve({ ok: false, error: { code, message: spawnErr.message }, exitCode, signal });
      } else if (parsed?.success) {
        resolve({ ok: true, stats: parsed.data?.stats, frames: parsed.data?.frames, exitCode, signal });
      } else if (signal) {
        resolve({ ok: true, exitCode, signal });
      } else {
        const error: PbError = parsed?.error ?? { code: 'EXIT', message: stderr.trim().split('\n').slice(-3).join(' | ') || `peekaboo exited ${exitCode}` };
        resolve({ ok: false, error, exitCode, signal });
      }
    };
    child.once('error', (e) => void finish(null, null, e));
    child.once('exit', (code, signal) => void finish(code, signal));
  });

  return {
    pid: child.pid,
    done,
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    },
  };
};

// ── Daemon / TCC self-heal ──

/**
 * macOS attributes a Screen Recording request to the *responsible app*. A
 * peekaboo daemon spawned from tmux or launchd has none, so no prompt ever
 * appears and the Screen Recording pane silently refuses bare binaries via "+".
 * The grant that works is Terminal.app's — so when the grant is missing, relaunch
 * the daemon (manual mode, survives idle) from Terminal.app via AppleScript.
 */
let lastDaemonRepair = 0;
export async function ensureDaemon(log: (...a: unknown[]) => void): Promise<Permissions> {
  const before = await permissions();
  if (before.screenRecording) return before;
  if (Date.now() - lastDaemonRepair < 10 * 60_000) return before;
  lastDaemonRepair = Date.now();
  log('Screen Recording not granted to the current peekaboo daemon; relaunching it under Terminal.app');
  try {
    await execFileP('osascript', ['-e', `tell application "Terminal" to do script "${PEEKABOO_BIN} daemon stop; ${PEEKABOO_BIN} daemon start; exit"`], { timeout: 15_000 });
  } catch (e) {
    log('osascript failed (Automation permission for Terminal?):', (e as Error).message);
    return before;
  }
  await new Promise(r => setTimeout(r, 5000));
  const after = await permissions();
  log(`after daemon relaunch: screenRecording=${after.screenRecording} accessibility=${after.accessibility}`);
  return after;
}

export async function daemonStatus(): Promise<string> {
  const r = await pb<{ pid?: number; lifecycleMode?: string; mode?: string }>(['daemon', 'status'], { timeoutMs: 10_000 });
  if (!r.success) return 'daemon: not running';
  const d = r.data ?? {};
  return `daemon pid ${d.pid ?? '?'} (${d.lifecycleMode ?? d.mode ?? 'auto'})`;
}
