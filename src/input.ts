/**
 * Input: click, type and press keys in the window the agent last looked at.
 *
 * Everything goes through Peekaboo's background delivery, which acts on one
 * exact window without moving the pointer or bringing the window forward. A
 * background click presses the accessibility element under the point, and
 * keystrokes follow that window's own keyboard focus.
 *
 * Off unless SCREEN_MCPL_INPUT=1, so a watch-only install lists the same
 * tools as before.
 */
import { openSync, readSync, closeSync } from 'node:fs';

export const INPUT_ENABLED = process.env.SCREEN_MCPL_INPUT === '1';

/** The window input acts on: set by a screen_look of an app window. */
export interface View {
  windowId: number;
  title: string;
  /** Window points per pixel of the image the agent was shown (≥ 1). */
  scale: number;
}

/** Peekaboo captures at 1x, so the raw PNG's pixels are window points; the agent
 *  sees it downscaled to at most `maxPx` on its longest side. */
export function viewScale(rawWidth: number, rawHeight: number, maxPx: number): number {
  return Math.max(1, Math.max(rawWidth, rawHeight) / maxPx);
}

/** A point in the shown image → "x,y" in window points, as `--at` wants it. */
export function windowPoint(view: View, x: number, y: number): string {
  return `${Math.round(x * view.scale)},${Math.round(y * view.scale)}`;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(path: string): { width: number; height: number } {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(24);
    readSync(fd, b, 0, 24, 0);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } finally { closeSync(fd); }
}

/** Peekaboo ends a failed background action with advice to re-run its CLI in the
 *  foreground. These tools have no foreground mode, so the advice would mislead. */
export function withoutCliAdvice(message: string): string {
  return message.replace(/\s*Re-run with --foreground[^.]*\./, '').trim();
}

export const inputToolDefinitions = [
  { name: 'screen_click',
    description: 'Click in the app window you last captured with screen_look. x and y are pixels in that image. The click goes to the window in the background: the pointer does not move and the window does not come forward. It presses the control under the point (a button, link, field, tab or menu item); a point with no control under it fails and says so. The result is text only, so look again to see what changed.',
    inputSchema: { type: 'object' as const, properties: {
      x: { type: 'number', description: 'Pixels from the left edge of the image.' },
      y: { type: 'number', description: 'Pixels from the top edge of the image.' },
    }, required: ['x', 'y'] } },
  { name: 'screen_type',
    description: 'Type text into whatever has keyboard focus in the app window you last captured with screen_look. Click a field first to focus it. Delivered in the background, like screen_click. Look again to confirm what arrived.',
    inputSchema: { type: 'object' as const, properties: {
      text: { type: 'string', description: 'The text to type.' },
    }, required: ['text'] } },
  { name: 'screen_press',
    description: 'Press keys in the app window you last captured with screen_look: "return", "tab", "shift+tab", "escape", "delete", "pagedown", "pageup", "space", "up", "down". Several keys separated by spaces are pressed in order. Keys go to whatever has keyboard focus in that window, in the background; in a browser, pagedown and pageup scroll the page. App shortcuts such as cmd+r, cmd+a or cmd+c reach the page as key events, but the app does not act on them while it is in the background.',
    inputSchema: { type: 'object' as const, properties: {
      keys: { type: 'string', description: 'One key or chord, or several separated by spaces.' },
    }, required: ['keys'] } },
];
