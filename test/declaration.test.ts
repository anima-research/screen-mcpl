import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import type { InitializeCapabilities05 } from '../src/mcpl05.js';

const BUILT = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

// Starts the built server with no saved watches, so nothing reaches Peekaboo.
test('the screen feature set declares its tags, with a rationale on every suggested rule (RFC-001 §5)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'screen-mcpl-decl-'));
  const child = spawn(process.execPath, [BUILT, '--stdio'], { env: { ...process.env, SCREEN_MCPL_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
  const conn = McplConnection.fromStreams(child.stdout, child.stdin);
  t.after(() => { conn.close(); child.kill(); rmSync(home, { recursive: true, force: true }); });

  const { capabilities } = await conn.sendRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'test', version: '0' },
  }, 15_000) as { capabilities: InitializeCapabilities05 };
  const [screen] = capabilities.experimental?.mcpl?.featureSets ?? [];
  assert.equal(screen?.name, 'screen');
  const ontology = screen.tagOntology;
  assert.ok(ontology, 'the screen feature set declares a tag ontology');
  assert.equal(ontology.open, true);
  const described = Object.keys(ontology.tags ?? {}).sort();
  assert.deepEqual(described, ['screen:change', 'screen:watch-state'], 'the two kinds of push; screen:watch:<id> is named in their descriptions');
  for (const tag of described) assert.match(ontology.tags![tag]!.desc, /screen:watch:<id>/);
  assert.ok((ontology.suggestedTreatment ?? []).length > 0);
  for (const rule of ontology.suggestedTreatment ?? []) {
    assert.ok(rule.rationale && rule.rationale.length > 20, `rule ${JSON.stringify(rule.tagsAny)} has a rationale`);
    for (const tag of [...rule.tagsAny ?? [], ...rule.tagsAll ?? [], ...rule.tagsNone ?? []]) assert.ok(described.includes(tag), `${tag} is described`);
  }
});
