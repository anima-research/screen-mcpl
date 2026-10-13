#!/usr/bin/env node
/**
 * screen-mcpl — watch parts of the macOS screen and get woken when they change.
 *
 * Backed by Peekaboo (`peekaboo capture live`, `peekaboo see`). Each watch is
 * a window / app / screen / region with a change threshold; bursts of change
 * are coalesced into one push/event carrying the last frame (motion boxes
 * highlighted) and a note saying why the agent was watching.
 *
 * Usage: screen-mcpl --stdio      (env: SCREEN_MCPL_HOME, PEEKABOO_BIN)
 */
import { McplConnection, method } from '@animalabs/mcpl-core';
import type { McplInitializeParams, PushEventParams, JsonRpcId, ContentBlock } from '@animalabs/mcpl-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { basename } from 'node:path';
import {
  EMPTY_GRANT, buildReceipt, deriveFeatureSetState, narrowGrant, parsePolicy,
} from './mcpl05.js';
import type {
  FeatureSetDeclaration05, FeatureSetMap, FeatureSetState, FeatureSetWireEntry, Grant,
  InitializeCapabilities05, McplInitializeResult05, McplServerCapabilities05,
} from './mcpl05.js';
import { daemonStatus, describeTarget, ensureDaemon, errorText, pb, permissions, targetArgs, type Target } from './peekaboo.js';
import { base64Of, renderFrame } from './image.js';
import { WatchManager, type Burst, type ImageMode, type WatchRuntime, type WatchSpec, type WatchState } from './watch.js';

const HOME = process.env.SCREEN_MCPL_HOME ?? join(homedir(), '.screen-mcpl');
const CONFIG_PATH = join(HOME, 'config.json');
const CAPTURES = join(HOME, 'captures');
const FS_NAME = 'screen';
const VERSION = '0.1.0';

const DEFAULTS = {
  threshold: 2.5,        // Peekaboo's own default: whole-frame % that counts as motion
  coalesceSeconds: 8,    // quiet period that closes a burst
  maxHoldSeconds: 60,    // continuous activity still yields a push this often
  minIntervalSeconds: 0,
  image: 'inline' as ImageMode,
  highlight: true,
  maxPx: 1024,
};

function log(...a: unknown[]): void { console.error('[screen-mcpl]', ...a); }

interface Config { watches: WatchSpec[] }
function loadConfig(): Config {
  try { if (existsSync(CONFIG_PATH)) { const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>; return { watches: Array.isArray(c.watches) ? c.watches : [] }; } }
  catch (e) { log('config read failed:', (e as Error).message); }
  return { watches: [] };
}
function saveConfig(c: Config): void {
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
  catch (e) { log('config write failed:', (e as Error).message); }
}

const featureSetDecl: FeatureSetDeclaration05 = {
  description: 'Watch windows, apps, screens or regions of the Mac display and wake the agent when they change; on-demand screenshots and UI maps.',
  uses: ['tools', 'pushEvents'],
  rollback: false,
};
const declaredFeatureSets: FeatureSetMap = { [FS_NAME]: featureSetDecl };
const featureSets: FeatureSetWireEntry[] = [{ name: FS_NAME, ...featureSetDecl }];

const targetProps = {
  app: { type: 'string', description: 'Application name or bundle id (e.g. "Safari", "com.apple.Terminal"). Captures that app\'s front window unless window/windowIndex is given.' },
  window: { type: 'string', description: 'Window title (substring) within app.' },
  windowIndex: { type: 'number', description: 'Window index within app (0 = frontmost), alternative to window.' },
  screen: { type: 'number', description: 'Screen index (0-based) — whole display. Default when no app/region is given.' },
  region: { type: 'string', description: 'Area of the display as "x,y,width,height" in global points.' },
};

const toolDefinitions = [
  { name: 'screen_watch',
    description: 'Start watching part of the screen. You will be woken (push event) when it changes — bursts of change are merged into one wake carrying the latest frame with the changed areas boxed. Pick ONE target: app (+ optional window), region, or screen. Give a note saying what you are looking for; it is repeated on every wake. Returns the watch id.',
    inputSchema: { type: 'object' as const, properties: {
      ...targetProps,
      label: { type: 'string', description: 'Short human name for this watch (defaults to the target).' },
      note: { type: 'string', description: 'Why you are watching / what to look for. Echoed on every wake.' },
      threshold: { type: 'number', description: `Percent of the frame that must change to count (default ${DEFAULTS.threshold}; lower = more sensitive, 0.5 catches a line of text).` },
      coalesceSeconds: { type: 'number', description: `Quiet period that closes a burst of changes into one wake (default ${DEFAULTS.coalesceSeconds}).` },
      maxHoldSeconds: { type: 'number', description: `Under continuous change, wake at least this often (default ${DEFAULTS.maxHoldSeconds}).` },
      minIntervalSeconds: { type: 'number', description: 'Never wake more often than this (default 0 = only coalescing limits it).' },
      image: { type: 'string', enum: ['inline', 'path', 'none'], description: `What the wake carries: inline JPEG + file path (default), path only, or text only.` },
      highlight: { type: 'boolean', description: `Draw boxes around changed areas on the frame (default ${DEFAULTS.highlight}).` },
    } } },
  { name: 'screen_unwatch', description: 'Stop a watch by id, or all of them with id "all".',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'screen_watches', description: 'List your watches with state (watching / waiting for app / blocked / paused), change and wake counts, plus Peekaboo permission status.',
    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'screen_watch_set', description: 'Adjust a running watch: pause/resume, threshold, coalescing, note, image mode.',
    inputSchema: { type: 'object' as const, properties: {
      id: { type: 'string' }, paused: { type: 'boolean' }, note: { type: 'string' }, label: { type: 'string' },
      threshold: { type: 'number' }, coalesceSeconds: { type: 'number' }, maxHoldSeconds: { type: 'number' }, minIntervalSeconds: { type: 'number' },
      image: { type: 'string', enum: ['inline', 'path', 'none'] }, highlight: { type: 'boolean' },
    }, required: ['id'] } },
  { name: 'screen_look', description: 'Take a look right now: screenshot of an app window / region / screen, optionally with its accessibility element map (elements: true) or OCR text (ocr: true). Returns the image and the file path.',
    inputSchema: { type: 'object' as const, properties: {
      ...targetProps,
      elements: { type: 'boolean', description: 'Also return the UI element map (ids, roles, labels) — needs Accessibility permission.' },
      ocr: { type: 'boolean', description: 'Add OCR text (implies elements).' },
      maxPx: { type: 'number', description: 'Longest side of the returned image (default 1280).' },
    } } },
  { name: 'screen_apps', description: 'List running apps; with app given, list that app\'s windows (titles, ids, bounds) so you can target a watch precisely.',
    inputSchema: { type: 'object' as const, properties: { app: { type: 'string' } } } },
];

interface ReqMsg { id: JsonRpcId; method: string; params?: unknown }
interface NotifMsg { method: string; params?: unknown }
type ToolResult = { content: ContentBlock[]; isError?: boolean };

function fmtTime(ms: number): string { return new Date(ms).toLocaleTimeString('en-GB', { hour12: false }); }
function ago(ms?: number): string { if (!ms) return 'never'; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`; }
function num(v: unknown, fallback: number, min = 0): number { return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback; }
function str(v: unknown): string | undefined { return typeof v === 'string' && v.trim() ? v.trim() : undefined; }

function parseTarget(args: Record<string, unknown>): Target | string {
  const t: Target = {};
  if (str(args.region)) t.region = str(args.region);
  if (str(args.app)) t.app = str(args.app);
  if (str(args.window)) t.windowTitle = str(args.window);
  if (typeof args.windowIndex === 'number') t.windowIndex = args.windowIndex;
  if (typeof args.screen === 'number') t.screenIndex = args.screen;
  if (t.region && !/^-?\d+,-?\d+,\d+,\d+$/.test(t.region)) return 'region must be "x,y,width,height" (integers)';
  if (t.region && t.app) return 'give either region or app, not both';
  if ((t.windowTitle || t.windowIndex != null) && !t.app) return 'window / windowIndex need app';
  return t;
}

function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'watch'; }

class ScreenServer {
  private conn: McplConnection | null = null;
  private config = loadConfig();
  private mcplEnabled = false;
  private grant: Grant = EMPTY_GRANT;
  private policyReady = false;
  private readonly watches: WatchManager;

  constructor() {
    this.watches = new WatchManager(CAPTURES, {
      push: (spec, rt, burst) => this.pushBurst(spec, rt, burst),
      stateChanged: (spec, rt, prev) => this.onStateChanged(spec, rt, prev),
      log,
    });
  }

  async serve(conn: McplConnection): Promise<void> {
    this.conn = conn;
    await this.handleInitialize();
    void this.resumeWatches();
    try {
      while (!conn.isClosed) {
        const msg = await conn.nextMessage();
        if (msg.type === 'request') await this.handleRequest(msg.request as ReqMsg);
        else this.handleNotification(msg.notification as NotifMsg);
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') log('connection error:', e);
    }
    this.watches.stopAll();
    this.conn = null;
  }

  private async resumeWatches(): Promise<void> {
    const perms = await ensureDaemon(log);
    log(`peekaboo permissions: screenRecording=${perms.screenRecording} accessibility=${perms.accessibility}${perms.error ? ` (${perms.error})` : ''}`);
    for (const spec of this.config.watches) {
      const r = await this.watches.start(spec, 1000);
      log(`resumed watch ${spec.id} (${spec.label}): ${JSON.stringify(r)}`);
    }
  }

  // ── Handshake / policy (verbatim semantics from heartbeat-mcpl; see SPEC §5–6) ──

  private async handleInitialize(): Promise<void> {
    const conn = this.conn!;
    const msg = await conn.nextMessage();
    if (msg.type !== 'request' || msg.request.method !== 'initialize') { log('expected initialize'); conn.close(); return; }
    const params = msg.request.params as McplInitializeParams | undefined;
    this.mcplEnabled = params?.capabilities?.experimental?.mcpl !== undefined;
    const serverCaps: McplServerCapabilities05 = { version: '0.5', pushEvents: true, featureSets };
    const capabilities: InitializeCapabilities05 = { tools: {}, ...(this.mcplEnabled ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult05 = { protocolVersion: '2024-11-05', capabilities, serverInfo: { name: 'screen-mcpl', version: VERSION } };
    conn.sendResponse(msg.request.id, result);
    log('initialize answered' + (this.mcplEnabled ? ' (MCPL mode; awaiting featureSets/update policy)' : ' (MCP mode; push events unavailable)'));
  }

  private async handleRequest(req: ReqMsg): Promise<void> {
    const conn = this.conn!;
    const params = (req.params ?? {}) as Record<string, unknown>;
    try {
      switch (req.method) {
        case 'tools/list': conn.sendResponse(req.id, { tools: toolDefinitions }); break;
        case 'tools/call': conn.sendResponse(req.id, await this.handleToolCall(params.name as string, (params.arguments ?? {}) as Record<string, unknown>)); break;
        case 'ping': conn.sendResponse(req.id, {}); break;
        case method.FEATURE_SETS_UPDATE: this.handleFeatureSetsUpdateRequest(req); break;
        default: conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (e) {
      conn.sendError(req.id, -32000, (e as Error).message);
    }
  }

  private handleNotification(notif: NotifMsg): void {
    switch (notif.method) {
      case 'notifications/initialized': log('initialized' + (this.mcplEnabled ? ' (MCPL mode)' : ' (MCP mode)')); break;
      case method.FEATURE_SETS_UPDATE: this.handleFeatureSetsUpdateNotification(notif); break;
      default: log(`ignored notification: ${notif.method}`);
    }
  }

  private handleFeatureSetsUpdateRequest(req: ReqMsg): void {
    const conn = this.conn!;
    const parsed = parsePolicy(req.params);
    if (!parsed.ok) {
      this.grant = EMPTY_GRANT; this.policyReady = false;
      log(`featureSets/update rejected as malformed: ${parsed.error}; grant cleared`);
      conn.sendError(req.id, -32602, `Invalid featureSets/update: ${parsed.error}`);
      return;
    }
    this.grant = parsed.grant; this.policyReady = true;
    const receipt = buildReceipt(declaredFeatureSets, this.grant);
    log(`featureSets/update applied: grant=[${this.grant.patterns.join(', ')}] mode=${receipt.mode}`);
    if (this.grant.denied.length > 0) log(`host deniedCapabilities (diagnostic): [${this.grant.denied.join(', ')}]`);
    for (const note of receipt.notes ?? []) log(`receipt note: ${note}`);
    conn.sendResponse(req.id, receipt);
  }

  private handleFeatureSetsUpdateNotification(notif: NotifMsg): void {
    const parsed = parsePolicy(notif.params);
    if (!parsed.ok) { log(`featureSets/update (Notification) malformed: ${parsed.error}; ignored`); return; }
    this.grant = narrowGrant(this.grant, parsed.grant, parsed.hadEffectiveCapabilities);
    log(`featureSets/update (Notification) applied as reduction: grant=[${this.grant.patterns.join(', ')}]`);
    if (!this.policyReady) log('WARNING: initial policy has not arrived as a Request; no wake will be delivered until it does (§5.3).');
  }

  private featureSetState(): FeatureSetState { return deriveFeatureSetState(FS_NAME, featureSetDecl, this.grant); }

  private pushBlockedReason(): string | null {
    if (!this.mcplEnabled) return 'host is MCP-only; push events unavailable';
    if (!this.policyReady) return 'no featureSets/update Request yet (§5.3)';
    const state = this.featureSetState();
    if (state.active) return null;
    if (state.reason === 'capability_denied') return `capability not granted: ${state.missing.join(', ')}`;
    return `feature set "${FS_NAME}" is ${state.reason}`;
  }

  // ── Pushes ──

  private async pushBurst(spec: WatchSpec, rt: WatchRuntime, burst: Burst): Promise<boolean> {
    const span = Math.max(1, Math.round((burst.lastAt - burst.firstAt) / 1000));
    const n = burst.frames.length;
    const lines = [
      `[screen] ${spec.label} changed — ${n === 1 ? '1 change' : `${n} changes over ${span}s`} (${fmtTime(burst.firstAt)}${n > 1 ? `–${fmtTime(burst.lastAt)}` : ''}), watch "${spec.id}"${rt.pushes > 0 ? `, wake #${burst.pushNumber}` : ', first wake'}.`,
    ];
    if (spec.note) lines.push(`Note to self: ${spec.note}`);
    if (burst.imagePath) {
      const diff = burst.changePercent != null ? ` — ~${Math.round(burst.changePercent)}% of the frame differs from the last wake${burst.boxes ? `, ${burst.boxes} area${burst.boxes === 1 ? '' : 's'} boxed in red` : ''}` : '';
      lines.push(`Frame: ${burst.imagePath}${diff}`);
    }
    if (burst.pushNumber <= 2) lines.push(`screen_look for a fresh view · screen_watch_set {id:"${spec.id}", …} to tune · screen_unwatch {id:"${spec.id}"} to stop.`);
    const content: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }];
    if (spec.image === 'inline' && burst.imagePath) {
      try { content.push({ type: 'image', data: await base64Of(burst.imagePath), mimeType: 'image/jpeg' }); }
      catch (e) { log('inline image failed:', (e as Error).message); }
    }
    return this.emitPush(content, { server: 'screen-mcpl', watch: spec.id, label: spec.label, target: describeTarget(spec.target), changes: n },
      ['screen:change', `screen:watch:${spec.id}`], `change_${spec.id}_${burst.pushNumber}`);
  }

  private onStateChanged(spec: WatchSpec, rt: WatchRuntime, prev: WatchState): void {
    log(`watch ${spec.id}: ${prev} → ${rt.state}${rt.reason ? ` (${rt.reason})` : ''}`);
    if (rt.state === 'blocked' && /permission/i.test(rt.reason ?? '')) void ensureDaemon(log);
    // Only transitions out of a working watch are worth a wake: the agent
    // asked for eyes on something and the eyes just closed.
    if (prev !== 'watching') return;
    if (rt.state !== 'waiting' && rt.state !== 'blocked') return;
    const text = rt.state === 'waiting'
      ? `[screen] ${spec.label} (watch "${spec.id}"): ${rt.reason}. I'll keep trying and resume automatically.`
      : `[screen] ${spec.label} (watch "${spec.id}") is blocked: ${rt.reason}. Retrying periodically.`;
    this.emitPush([{ type: 'text', text }], { server: 'screen-mcpl', watch: spec.id, label: spec.label, state: rt.state },
      ['screen:watch-state', `screen:watch:${spec.id}`], `state_${spec.id}_${rt.state}_${Date.now()}`);
  }

  private emitPush(content: ContentBlock[], origin: Record<string, unknown>, tags: string[], eventId: string): boolean {
    const conn = this.conn;
    if (!conn) return false;
    const blocked = this.pushBlockedReason();
    if (blocked) { log(`suppressed push ${eventId} — ${blocked}`); return false; }
    const params: PushEventParams & { tags: string[] } = {
      featureSet: FS_NAME, eventId, timestamp: new Date().toISOString(), origin, tags, payload: { content },
    };
    conn.sendRequest(method.PUSH_EVENT, params)
      .then((r) => { const a = (r as { accepted?: unknown } | null)?.accepted; log(a === false ? `push ${eventId} NOT accepted: ${JSON.stringify(r)}` : `push ${eventId} accepted`); })
      .catch((e) => log(`push ${eventId} failed:`, (e as Error).message));
    return true;
  }

  // ── Tools ──

  private text(t: string, isError?: boolean): ToolResult { return { content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) }; }

  private async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'screen_watch': return this.toolWatch(args);
      case 'screen_unwatch': return this.toolUnwatch(args);
      case 'screen_watches': return this.toolWatches();
      case 'screen_watch_set': return this.toolWatchSet(args);
      case 'screen_look': return this.toolLook(args);
      case 'screen_apps': return this.toolApps(args);
      default: return this.text(`Unknown tool: ${name}`, true);
    }
  }

  private persist(): void {
    this.config.watches = this.watches.list().map(w => w.spec);
    saveConfig(this.config);
  }

  private async toolWatch(args: Record<string, unknown>): Promise<ToolResult> {
    const target = parseTarget(args);
    if (typeof target === 'string') return this.text(target, true);
    const label = str(args.label) ?? describeTarget(target);
    let id = slug(str(args.label) ?? target.app ?? (target.region ? 'region' : 'screen'));
    for (let i = 2; this.watches.get(id); i++) id = `${slug(label)}-${i}`;
    const image = (['inline', 'path', 'none'] as const).find(m => m === args.image) ?? DEFAULTS.image;
    const spec: WatchSpec = {
      id, label, note: str(args.note), target,
      threshold: num(args.threshold, DEFAULTS.threshold),
      coalesceSeconds: num(args.coalesceSeconds, DEFAULTS.coalesceSeconds, 1),
      maxHoldSeconds: num(args.maxHoldSeconds, DEFAULTS.maxHoldSeconds, 5),
      minIntervalSeconds: num(args.minIntervalSeconds, DEFAULTS.minIntervalSeconds),
      image, highlight: typeof args.highlight === 'boolean' ? args.highlight : DEFAULTS.highlight,
      maxPx: DEFAULTS.maxPx, paused: false, createdAt: Date.now(),
    };
    const first = await this.watches.start(spec);
    this.persist();
    const blocked = this.pushBlockedReason();
    const tail = blocked ? `\n⚠ Wakes cannot be delivered right now: ${blocked}. The watch runs anyway; screen_watches shows what it has seen.` : '';
    if (!first.ok) return this.text(`Watch "${id}" created but not capturing yet — ${first.state}: ${first.reason}. It retries on its own; screen_unwatch {id:"${id}"} to drop it.${tail}`);
    const seen = 'pending' in first ? 'capture starting (no baseline frame within 8s yet — check screen_watches shortly)' : 'baseline frame captured';
    return this.text(`Watching ${describeTarget(target)} as "${id}" — ${seen}. You'll be woken when ≥${spec.threshold}% of it changes; bursts merge after ${spec.coalesceSeconds}s quiet (max hold ${spec.maxHoldSeconds}s).${spec.note ? ` Note: ${spec.note}` : ''}${tail}`);
  }

  private toolUnwatch(args: Record<string, unknown>): ToolResult {
    const id = str(args.id);
    if (!id) return this.text('id required ("all" to stop everything)', true);
    if (id === 'all') { const n = this.watches.list().length; this.watches.stopAll(); this.persist(); return this.text(`Stopped ${n} watch${n === 1 ? '' : 'es'}.`); }
    const ok = this.watches.stop(id);
    this.persist();
    return ok ? this.text(`Stopped watch "${id}".`) : this.text(`No watch "${id}". ${this.listLine()}`, true);
  }

  private listLine(): string { const ids = this.watches.list().map(w => w.spec.id); return ids.length ? `Active: ${ids.join(', ')}.` : 'No active watches.'; }

  private async toolWatches(): Promise<ToolResult> {
    const [perms, daemon] = await Promise.all([permissions(), daemonStatus()]);
    const lines = [`Peekaboo ${daemon}: screen recording ${perms.screenRecording ? 'OK' : 'NOT GRANTED'}, accessibility ${perms.accessibility ? 'OK' : 'NOT GRANTED'}${perms.error ? ` — ${perms.error}` : ''}. Wake delivery: ${this.pushBlockedReason() ?? 'ok'}.`];
    const ws = this.watches.list();
    if (ws.length === 0) lines.push('No watches. screen_watch {app:"Safari", note:"…"} to start one.');
    for (const { spec, rt } of ws) {
      lines.push(`• ${spec.id} — ${spec.label} [${rt.state}${rt.reason ? `: ${rt.reason}` : ''}] ${describeTarget(spec.target)} · threshold ${spec.threshold}% · coalesce ${spec.coalesceSeconds}s/hold ${spec.maxHoldSeconds}s · image ${spec.image}`
        + `\n    changes ${rt.changes} (last ${ago(rt.lastChangeAt)}) · wakes ${rt.pushes} (last ${ago(rt.lastPushAt)}) · last frame ${ago(rt.lastFrameAt)} · segment ${rt.segment}${rt.lastSegmentStats ? ` (${rt.lastSegmentStats})` : ''}${spec.note ? `\n    note: ${spec.note}` : ''}`);
    }
    return this.text(lines.join('\n'));
  }

  private toolWatchSet(args: Record<string, unknown>): ToolResult {
    const id = str(args.id);
    if (!id) return this.text('id required', true);
    const cur = this.watches.get(id);
    if (!cur) return this.text(`No watch "${id}". ${this.listLine()}`, true);
    const patch: Partial<WatchSpec> = {};
    if (typeof args.paused === 'boolean') patch.paused = args.paused;
    if (str(args.note)) patch.note = str(args.note);
    if (str(args.label)) patch.label = str(args.label);
    if (typeof args.threshold === 'number') patch.threshold = num(args.threshold, cur.spec.threshold);
    if (typeof args.coalesceSeconds === 'number') patch.coalesceSeconds = num(args.coalesceSeconds, cur.spec.coalesceSeconds, 1);
    if (typeof args.maxHoldSeconds === 'number') patch.maxHoldSeconds = num(args.maxHoldSeconds, cur.spec.maxHoldSeconds, 5);
    if (typeof args.minIntervalSeconds === 'number') patch.minIntervalSeconds = num(args.minIntervalSeconds, cur.spec.minIntervalSeconds);
    if (args.image === 'inline' || args.image === 'path' || args.image === 'none') patch.image = args.image;
    if (typeof args.highlight === 'boolean') patch.highlight = args.highlight;
    if (Object.keys(patch).length === 0) return this.text('Nothing to change.', true);
    // threshold/highlight only take effect at the next segment (≤3 min) — restart now so they apply immediately.
    const needsRestart = !cur.spec.paused && patch.paused !== true && ('threshold' in patch || 'highlight' in patch);
    const spec = this.watches.update(id, needsRestart ? { ...patch, paused: true } : patch)!;
    if (needsRestart) this.watches.update(id, { paused: false });
    this.persist();
    return this.text(`Updated "${id}": ${Object.keys(patch).join(', ')}. Now ${spec.paused ? 'PAUSED' : 'running'}, threshold ${spec.threshold}%, coalesce ${spec.coalesceSeconds}s.`);
  }

  private async toolLook(args: Record<string, unknown>): Promise<ToolResult> {
    const target = parseTarget(args);
    if (typeof target === 'string') return this.text(target, true);
    const elements = args.elements === true || args.ocr === true;
    const dir = join(CAPTURES, '_look');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const png = join(dir, `look-${stamp}.png`);
    const cmd = ['see', ...targetArgs(target), '--path', png, ...(elements ? [] : ['--no-elements']), ...(args.ocr === true ? ['--ocr'] : [])];
    const r = await pb<LookData>(cmd, { timeoutMs: 45_000 });
    if (!r.success) return this.text(`Look failed for ${describeTarget(target)}: ${errorText(r)}`, true);
    const d = r.data ?? {};
    const maxPx = num(args.maxPx, 1280, 200);
    let jpg: string | undefined;
    try { jpg = (await renderFrame(d.screenshot_raw ?? png, png.replace(/\.png$/, '.jpg'), maxPx)).path; } catch (e) { log('look jpeg failed:', (e as Error).message); }
    const head = [`${describeTarget(target)}${d.application_name ? ` — ${d.application_name}` : ''}${d.window_title ? `: "${d.window_title}"` : ''} at ${fmtTime(Date.now())}.`];
    head.push(`Image: ${jpg ?? d.screenshot_raw ?? png}`);
    if (elements && Array.isArray(d.ui_elements)) {
      head.push(`${d.element_count ?? d.ui_elements.length} elements (${d.interactable_count ?? '?'} interactable)${d.ui_map ? `, full map: ${d.ui_map}` : ''}:`);
      for (const e of d.ui_elements.slice(0, 60)) head.push('  ' + summarizeElement(e));
      if (d.ui_elements.length > 60) head.push(`  … ${d.ui_elements.length - 60} more in the map file`);
    }
    const content: ContentBlock[] = [{ type: 'text', text: head.join('\n') }];
    if (jpg) { try { content.push({ type: 'image', data: await base64Of(jpg), mimeType: 'image/jpeg' }); } catch { /* path still in text */ } }
    return { content };
  }

  private async toolApps(args: Record<string, unknown>): Promise<ToolResult> {
    const app = str(args.app);
    if (!app) {
      const r = await pb<{ apps?: AppRow[] }>(['app', 'list']);
      if (!r.success) return this.text(`app list failed: ${errorText(r)}`, true);
      const rows = (r.data?.apps ?? []).map(a => `• ${a.name}${a.is_active ? ' (active)' : ''}${a.is_hidden ? ' (hidden)' : ''} — ${a.bundle_id ?? ''} pid ${a.pid ?? '?'}`);
      return this.text(rows.length ? `${rows.length} running apps:\n${rows.join('\n')}\nscreen_apps {app:"Name"} for its windows.` : 'No apps reported.');
    }
    const r = await pb<Record<string, unknown>>(['window', 'list', '--app', app]);
    if (!r.success) return this.text(`window list failed for ${app}: ${errorText(r)}`, true);
    const wins = findArray(r.data, 'windows');
    const rows = wins.map((w, i) => {
      const o = w as Record<string, unknown>;
      const id = o.window_id ?? o.id ?? o.windowID;
      const title = o.title ?? o.window_title ?? o.name ?? '(untitled)';
      const b = o.bounds as Record<string, number> | undefined;
      const bounds = b ? ` ${b.width ?? b.w}×${b.height ?? b.h} @ ${b.x},${b.y}` : '';
      const flags = [o.is_minimized ? 'minimized' : '', o.is_off_screen || o.off_screen ? 'off-screen' : '', o.observation_capability ? String(o.observation_capability) : ''].filter(Boolean).join(', ');
      return `• [${i}] "${title}"${id != null ? ` id ${id}` : ''}${bounds}${flags ? ` (${flags})` : ''}`;
    });
    return this.text(rows.length ? `${app}: ${rows.length} window${rows.length === 1 ? '' : 's'}\n${rows.join('\n')}\nUse screen_watch {app:"${app}", window:"<title substring>"} or windowIndex.` : `${app}: no windows listed.`);
  }
}

interface AppRow { name: string; bundle_id?: string; pid?: number; is_active?: boolean; is_hidden?: boolean }
interface LookData { screenshot_raw?: string; application_name?: string; window_title?: string; element_count?: number; interactable_count?: number; ui_map?: string; ui_elements?: unknown[] }

function findArray(d: unknown, key: string): unknown[] {
  if (!d || typeof d !== 'object') return [];
  const o = d as Record<string, unknown>;
  if (Array.isArray(o[key])) return o[key] as unknown[];
  for (const v of Object.values(o)) { if (v && typeof v === 'object' && !Array.isArray(v)) { const r = findArray(v, key); if (r.length) return r; } }
  return [];
}

function summarizeElement(e: unknown): string {
  if (!e || typeof e !== 'object') return String(e);
  const o = e as Record<string, unknown>;
  const pick = (...ks: string[]) => { for (const k of ks) { const v = o[k]; if (typeof v === 'string' && v.trim()) return v.trim(); } return ''; };
  const id = pick('id', 'element_id', 'identifier');
  const role = pick('role', 'type');
  const label = pick('label', 'title', 'name', 'description');
  const value = pick('value', 'text');
  const parts = [id && `[${id}]`, role, label && `"${label.slice(0, 60)}"`, value && `= ${value.slice(0, 40)}`, o.is_actionable === true || o.actionable === true ? '(actionable)' : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : JSON.stringify(o).slice(0, 100);
}

// ── main ──

async function main(): Promise<void> {
  if (!process.argv.includes('--stdio')) {
    console.error(`screen-mcpl ${VERSION} — watch the Mac screen via Peekaboo and push changes to the agent.\nUsage: ${basename(process.argv[1] ?? 'screen-mcpl')} --stdio   (env SCREEN_MCPL_HOME=${HOME}, PEEKABOO_BIN)`);
    process.exit(2);
  }
  mkdirSync(CAPTURES, { recursive: true });
  const conn = McplConnection.fromStreams(process.stdin, process.stdout);
  const server = new ScreenServer();
  const bye = () => { log('shutting down'); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  await server.serve(conn);
  process.exit(0);
}
main().catch((e) => { log('fatal:', e); process.exit(1); });
