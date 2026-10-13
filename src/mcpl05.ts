/**
 * MCPL 0.5 wire shapes and policy derivation.
 *
 * `@animalabs/mcpl-core@0.2.1` still carries the 0.4 shapes: its
 * `FeatureSetDeclaration` requires the removed `hostState` and carries a `name`
 * member the 0.5 schema does not define (App. B.2), its `FeatureSetsUpdateParams`
 * has no `effectiveCapabilities`/`deniedCapabilities`, and there is no
 * degradation-receipt type. Nothing is published yet, so the types below are
 * written against SPEC.md (0.5.0-draft) directly and this module is the single
 * place that has to change when the core library catches up.
 *
 * Everything here is pure — no I/O, no connection state — so the fail-closed
 * derivation can be unit-tested (test/policy.test.ts).
 */

/**
 * The complete `uses` vocabulary — SPEC §6.2 / App. B.2. This list is closed:
 * `uses` MUST contain only these values, and a declaration carrying anything else
 * is invalid (§6.4.1). Typing our declaration against it means a future feature
 * set cannot quietly invent a path.
 */
export const CAPABILITY_PATHS = [
  'pushEvents',
  'tools',
  'modelInfo',
  'inferenceRequest',
  'inferenceRequest.streaming',
  'inferenceLifecycle',
  'contextHooks.beforeInference.observe',
  'contextHooks.beforeInference.inject.system',
  'contextHooks.beforeInference.inject.beforeUser',
  'contextHooks.beforeInference.inject.afterUser',
  'channels.register',
  'channels.lifecycle',
  'channels.publish',
  'channels.incoming',
  'channels.streaming',
  'channels.acknowledge',
  'channels.typing',
] as const;

export type CapabilityPath = (typeof CAPABILITY_PATHS)[number];

const CAPABILITY_PATH_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_PATHS);

export function isCapabilityPath(value: unknown): value is CapabilityPath {
  return typeof value === 'string' && CAPABILITY_PATH_SET.has(value);
}

/**
 * A feature-set declaration — SPEC §6.1, §6.2, App. B.2 (`required:
 * ["description", "uses"]`), plus `rollback` from §8.1. `hostState` was removed
 * in 0.4.1 and is gone.
 *
 * NOTE ON THE WIRE SHAPE. §6.1 and App. B.2 declare `featureSets` as an **object
 * keyed by name**, with no `name` member on the declaration. This server still
 * ships the 0.4 array-of-`{name, …}` form, because that is what the ecosystem
 * currently reads:
 *   - agent-framework accepts both (mcpl/feature-set-manager.ts:154-161);
 *   - mcpl-harness accepts **only** the array (src/session.ts:493-497) and
 *     throws `(decls ?? []) is not iterable` on the object form.
 * Switching unilaterally would break this repo's own e2e host, and the manifest
 * shape also feeds the §17.2 canonical digest, so it is an ecosystem migration
 * rather than a one-server edit. Filed as a finding on issue #3; nothing here
 * depends on which shape is used.
 */
export interface FeatureSetDeclaration05 {
  description: string;
  uses: CapabilityPath[];
  /** §8.1 — rollback support. This server is stateless, so `false`. */
  rollback?: boolean;
}

/** The name-keyed view the derivation works over, independent of wire shape. */
export type FeatureSetMap = Record<string, FeatureSetDeclaration05>;

/** One element of the transitional array wire shape (see the note above). */
export type FeatureSetWireEntry = FeatureSetDeclaration05 & { name: string };

/** `featureSets/update` params — SPEC §5.3, §6.7. */
export interface FeatureSetsUpdateParams05 {
  /** §5.4: the sole normative allowlist. Absence of a path is denial. */
  effectiveCapabilities?: unknown;
  /** §5.4: derived diagnostic data only; MUST NOT authorize anything. */
  deniedCapabilities?: unknown;
  enabled?: unknown;
  disabled?: unknown;
}

/**
 * The server's advertisement — SPEC §5.1. Advertisement mirrors the capability
 * paths, and `false` or absence means none: this server advertises `pushEvents`
 * and nothing else, so every other capability is simply absent. `tools` rides on
 * MCP's own `capabilities.tools` and is not repeated inside the MCPL block.
 */
export interface McplServerCapabilities05 {
  version: string;
  /** §17.2 canonical content digest. Omitted: this server's manifest is fixed
   *  for the life of the connection and it implements neither §17 method. */
  revision?: string;
  pushEvents?: boolean;
  featureSets?: FeatureSetWireEntry[];
}

export interface InitializeCapabilities05 {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  experimental?: { mcpl?: McplServerCapabilities05 };
}

export interface McplInitializeResult05 {
  protocolVersion: string;
  capabilities: InitializeCapabilities05;
  serverInfo: { name: string; version: string };
}

export interface UnavailableFeature {
  featureSet: string;
  missingCapabilities: string[];
  effect: 'disabled';
}

/** The degradation receipt — SPEC §6.7. Testimony about consequences, never a
 *  claim of entitlement: the host MUST NOT widen a grant because of it. */
export interface AcceptedReceipt {
  accepted: true;
  mode: 'full' | 'degraded';
  unavailableFeatures: UnavailableFeature[];
  notes?: string[];
}

/**
 * The refusal form of the receipt (§6.7). This server never emits one — losing
 * `pushEvents` costs it its wakes but its tools still answer, so `accepted:
 * true, mode: "degraded"` is the honest report. Refusing would be the coercion
 * lever §6.7 names ("I will not start unless you grant X"). The type is kept
 * because it is part of the method's contract.
 */
export interface RefusedReceipt {
  accepted: false;
  fallback: 'mcp-only' | 'close';
  missingCapabilities?: string[];
  reason?: string;
}

export type DegradationReceipt = AcceptedReceipt | RefusedReceipt;

/**
 * The effective grant as this server understands it. Constructed only from a
 * host-sent `featureSets/update`; there is no server-side default and no way for
 * the server to add to it (§5.4 — advertisement is an input, never an
 * authorization).
 */
export interface Grant {
  /** Raw `effectiveCapabilities` patterns, verbatim from the host — kept for
   *  operator-facing logging only. Authorization reads `paths`. */
  readonly patterns: readonly string[];
  /** The §6.2 paths those patterns resolve to. Authorization is set membership
   *  here, so nothing outside the closed vocabulary can ever be granted. */
  readonly paths: ReadonlySet<CapabilityPath>;
  /** `deniedCapabilities`, verbatim. §5.4: diagnostics only, and it takes part
   *  in no decision — it is carried so an operator can be told why. */
  readonly denied: readonly string[];
  /** Feature sets the host named in `disabled` (patterns, §6.3 wildcards). */
  readonly disabled: readonly string[];
  /** Feature sets the host named in `enabled`, or null when the field was absent. */
  readonly enabled: readonly string[] | null;
}

export const EMPTY_GRANT: Grant = {
  patterns: [],
  paths: new Set<CapabilityPath>(),
  denied: [],
  disabled: [],
  enabled: null,
};

export type PolicyParse =
  | { ok: true; grant: Grant; hadEffectiveCapabilities: boolean }
  | { ok: false; error: string };

function stringArray(value: unknown, field: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: `"${field}" must be an array of strings` };
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, error: `"${field}" must contain only strings` };
  }
  return { ok: true, value: value as string[] };
}

/**
 * Match one capability path against one grant pattern.
 *
 * §5.4: "Matching is over full paths with `*` wildcards, and implementations
 * MUST perform a **generic recursive walk** — a hardcoded set of nestable keys is
 * non-conforming, since the vocabulary is depth 3 and will grow." So this splits
 * on `.` and walks segments generically; it knows nothing about which keys nest.
 *
 * The spec does not say whether `*` spans one segment or a whole subtree, so the
 * narrow reading is used: `*` matches exactly one segment. `channels.*` therefore
 * grants `channels.publish` but `contextHooks.*` grants none of the depth-4
 * injection leaves, and a bare `*` matches only depth-1 paths. Erring here can
 * only deny a capability the host meant to give, never grant one it did not.
 */
export function capabilityMatches(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const q = path.split('.');
  if (p.length !== q.length) return false;
  return p.every((seg, i) => seg === '*' || seg === q[i]);
}

/**
 * Resolve host patterns to the concrete §6.2 paths they cover.
 *
 * Because the vocabulary is closed (App. B.2 declares it as an enum), resolving
 * once at parse time makes every later question — "is this granted?", "what
 * survives a narrowing?" — plain set arithmetic, with no second matching rule to
 * get subtly wrong. A pattern that resolves to nothing (a future path this build
 * does not know) simply grants nothing here, which is fail-closed and harmless
 * since this server never exercises a path outside the list.
 */
export function resolvePaths(patterns: readonly string[]): Set<CapabilityPath> {
  const out = new Set<CapabilityPath>();
  for (const path of CAPABILITY_PATHS) {
    if (patterns.some((pattern) => capabilityMatches(pattern, path))) out.add(path);
  }
  return out;
}

export function capabilityGranted(grant: Grant, path: CapabilityPath): boolean {
  return grant.paths.has(path);
}

/**
 * Validate `featureSets/update` params (§5.3, §5.4).
 *
 * Fail-closed at every step: a malformed message yields no grant at all rather
 * than a partial one. §5.4 makes one contradiction explicitly fatal — a path
 * present in both `effectiveCapabilities` and `deniedCapabilities` means the
 * receiver "MUST fail closed and reject the policy message as malformed".
 *
 * Absent `effectiveCapabilities` is *not* malformed: §5.4 says every path not
 * present is denied and there is no unspecified state, so an absent list is a
 * grant of nothing. §5.3 requires the host to send policy "even when nothing is
 * enabled or disabled", and a server defaulted to fully disabled still has to be
 * told — so this parses, and the receipt reports the degradation.
 */
export function parsePolicy(rawParams: unknown): PolicyParse {
  if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
    return { ok: false, error: 'params must be an object' };
  }
  const params = (rawParams ?? {}) as FeatureSetsUpdateParams05;

  let effective: string[] = [];
  let hadEffectiveCapabilities = false;
  if (params.effectiveCapabilities !== undefined) {
    const parsed = stringArray(params.effectiveCapabilities, 'effectiveCapabilities');
    if (!parsed.ok) return parsed;
    effective = parsed.value;
    hadEffectiveCapabilities = true;
  }

  let denied: string[] = [];
  if (params.deniedCapabilities !== undefined) {
    const parsed = stringArray(params.deniedCapabilities, 'deniedCapabilities');
    if (!parsed.ok) return parsed;
    denied = parsed.value;
  }

  // §5.4: both lists naming the same path is a contradiction, not a preference.
  const contradiction = effective.filter((p) => denied.includes(p));
  if (contradiction.length > 0) {
    return { ok: false, error: `path(s) in both effectiveCapabilities and deniedCapabilities: ${contradiction.join(', ')}` };
  }

  let enabled: string[] | null = null;
  if (params.enabled !== undefined) {
    const parsed = stringArray(params.enabled, 'enabled');
    if (!parsed.ok) return parsed;
    enabled = parsed.value;
  }

  let disabled: string[] = [];
  if (params.disabled !== undefined) {
    const parsed = stringArray(params.disabled, 'disabled');
    if (!parsed.ok) return parsed;
    disabled = parsed.value;
  }

  return {
    ok: true,
    grant: { patterns: effective, paths: resolvePaths(effective), denied, disabled, enabled },
    hadEffectiveCapabilities,
  };
}

/** §6.3 feature-set name matching: exact, or a `foo.*` prefix wildcard. */
export function featureSetMatches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keep the trailing dot
    return name.startsWith(prefix);
  }
  return false;
}

export type FeatureSetDisabledReason = 'invalid_uses' | 'capability_denied' | 'host_disabled' | 'not_enabled';

export interface FeatureSetState {
  active: boolean;
  /** Paths from `uses` that the grant does not cover. */
  missing: string[];
  reason?: FeatureSetDisabledReason;
}

/**
 * Derive a feature set's state from the grant — SPEC §6.4, fail-closed.
 *
 *  1. Absent, empty, or unrecognized `uses` ⇒ `invalid_uses`. We do not guess.
 *  2. Any path in `uses` outside the grant ⇒ disabled; absence is denial (§5.4).
 *  3. The host naming it in `disabled` ⇒ disabled, respected immediately (§6.7).
 *  4. An `enabled` list that is present and does not cover us ⇒ not enabled. In
 *     §5.3's example `enabled`/`disabled` mirror the derivation exactly, so a
 *     conforming host that grants our capabilities also lists us; treating the
 *     omission as denial is the fail-closed reading of an otherwise unspecified
 *     state. An absent `enabled` field constrains nothing.
 */
export function deriveFeatureSetState(name: string, decl: FeatureSetDeclaration05, grant: Grant): FeatureSetState {
  const uses = decl.uses;
  if (!Array.isArray(uses) || uses.length === 0 || !uses.every(isCapabilityPath)) {
    return { active: false, missing: [], reason: 'invalid_uses' };
  }
  const missing = uses.filter((path) => !capabilityGranted(grant, path));
  if (missing.length > 0) return { active: false, missing, reason: 'capability_denied' };
  if (grant.disabled.some((pattern) => featureSetMatches(pattern, name))) {
    return { active: false, missing: [], reason: 'host_disabled' };
  }
  if (grant.enabled !== null && !grant.enabled.some((pattern) => featureSetMatches(pattern, name))) {
    return { active: false, missing: [], reason: 'not_enabled' };
  }
  return { active: true, missing: [] };
}

/**
 * Build the degradation receipt for a set of declarations (§6.7).
 *
 * This is consequence testimony: it says what the server will do under the grant
 * it was just handed. It never asks for more, and it never reports a capability
 * as available that the grant did not contain — a receipt that lied about that
 * would be self-attestation wearing a different hat.
 */
export function buildReceipt(decls: FeatureSetMap, grant: Grant): AcceptedReceipt {
  const unavailable: UnavailableFeature[] = [];
  const notes: string[] = [];
  for (const [name, decl] of Object.entries(decls)) {
    const state = deriveFeatureSetState(name, decl, grant);
    if (state.active) continue;
    unavailable.push({ featureSet: name, missingCapabilities: state.missing, effect: 'disabled' });
    if (state.reason === 'invalid_uses') notes.push(`${name}: declaration is invalid (uses)`);
    if (state.reason === 'host_disabled') notes.push(`${name}: disabled by host policy`);
    if (state.reason === 'not_enabled') notes.push(`${name}: not listed in enabled`);
    if (state.reason === 'capability_denied') {
      notes.push(`${name}: disabled — scheduled wakes will not be delivered while ${state.missing.join(', ')} is denied; tools remain answerable over plain MCP`);
    }
  }
  return {
    accepted: true,
    mode: unavailable.length === 0 ? 'full' : 'degraded',
    unavailableFeatures: unavailable,
    notes,
  };
}

/**
 * Narrow an existing grant by another one — used for the Notification form of
 * `featureSets/update`.
 *
 * §6.7: a Notification "cannot establish a ready state" and is valid only for
 * metadata "that does not alter the grant", while §6.7 also requires servers to
 * "immediately respect a reduction". Intersecting satisfies both: a Notification
 * can only ever take capability away.
 *
 * Every dimension narrows, including `enabled` — an incoming list is applied
 * even when we currently hold none, because null means "unconstrained" and
 * adding a constraint is a reduction.
 */
export function narrowGrant(current: Grant, incoming: Grant, incomingHasCapabilities: boolean): Grant {
  const paths = incomingHasCapabilities
    ? new Set<CapabilityPath>([...current.paths].filter((p) => incoming.paths.has(p)))
    : current.paths;
  let enabled = current.enabled;
  if (incoming.enabled !== null) {
    enabled = current.enabled === null
      ? incoming.enabled
      : current.enabled.filter((name) => incoming.enabled!.includes(name));
  }
  return {
    patterns: incomingHasCapabilities ? [...paths] : current.patterns,
    paths,
    denied: [...current.denied, ...incoming.denied],
    disabled: [...current.disabled, ...incoming.disabled],
    enabled,
  };
}
