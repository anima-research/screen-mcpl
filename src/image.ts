/**
 * Frame post-processing. Preferred: `framebox` (tools/framebox.swift, compiled
 * at build time) — diffs against the previous pushed frame, boxes the changed
 * regions and writes the downscaled JPEG. Fallback: stock macOS `sips`
 * (downscale only, no boxes).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const FRAMEBOX = fileURLToPath(new URL('../framebox', import.meta.url)); // dist/framebox next to dist/src/
let frameboxAvailable: boolean | undefined;

export interface RenderedFrame { path: string; bytes: number; boxes?: number; changePercent?: number }
export type RenderFrame = (cur: string, out: string, maxPx: number, prev?: string, highlight?: boolean) => Promise<RenderedFrame>;

export const renderFrame: RenderFrame = async (cur, out, maxPx, prev, highlight = true) => {
  if (frameboxAvailable === undefined) {
    try { await access(FRAMEBOX); frameboxAvailable = true; } catch { frameboxAvailable = false; }
  }
  if (frameboxAvailable) {
    try {
      const args = [cur, out, String(maxPx), ...(prev && highlight ? [prev] : [])];
      const { stdout } = await execFileP(FRAMEBOX, args, { timeout: 20_000 });
      const info = JSON.parse(stdout.trim() || '{}') as { boxes?: number; changePercent?: number };
      const s = await stat(out);
      return { path: out, bytes: s.size, ...(prev && highlight ? { boxes: info.boxes, changePercent: info.changePercent } : {}) };
    } catch (e) {
      console.error('[screen-mcpl] framebox failed, falling back to sips:', (e as Error).message);
    }
  }
  await execFileP('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72', '-Z', String(maxPx), cur, '--out', out], { timeout: 20_000 });
  const s = await stat(out);
  return { path: out, bytes: s.size };
};

export async function base64Of(path: string): Promise<string> {
  return (await readFile(path)).toString('base64');
}
