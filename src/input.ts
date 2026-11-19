/**
 * Input: click, type, press keys, scroll and drag in what the agent last looked at.
 *
 * This is real mouse and keyboard input, delivered through Peekaboo's foreground
 * route: the pointer moves, and a looked-at window is brought to the front first.
 * It therefore works on any app, as a person's hands would, and it shares the one
 * pointer and keyboard focus with whoever else is using the Mac.
 *
 * click, type and press also take `quiet: true`, which uses Peekaboo's background route
 * instead: nothing moves and nothing comes forward, but only standard controls accept it.
 *
 * Off unless SCREEN_MCPL_INPUT=1, so a watch-only install lists the same tools
 * as before.
 */
export const INPUT_ENABLED = process.env.SCREEN_MCPL_INPUT === '1';

/** What input is aimed at: the last screen_look, whatever it captured. */
export interface View {
  /** Top-left corner of the captured area, in global display points. */
  originX: number;
  originY: number;
  /** Display points per pixel of the image the agent was shown (≥ 1). */
  scale: number;
  /** Set when the look captured an app window: it is brought forward before each action. */
  windowId?: number;
  label: string;
}

/** Peekaboo captures at 1x, so the captured area's size in points is the raw image's
 *  size in pixels; the agent sees it downscaled to at most `maxPx` on its longest side. */
export function viewScale(width: number, height: number, maxPx: number): number {
  return Math.max(1, Math.max(width, height) / maxPx);
}

/** A point in the shown image → "x,y" in global display points. */
export function globalPoint(view: View, x: number, y: number): string {
  return `${Math.round(view.originX + x * view.scale)},${Math.round(view.originY + y * view.scale)}`;
}

/** A point in the shown image → "x,y" in points relative to the looked-at window, for the quiet route. */
export function windowPoint(view: View, x: number, y: number): string {
  return `${Math.round(x * view.scale)},${Math.round(y * view.scale)}`;
}

/** Peekaboo ends a quiet refusal with advice about its own CLI flags and commands, which
 *  these tools do not have. Keep what it found, drop the advice. */
export function withoutCliAdvice(message: string): string {
  return message.split(/\s+(?:Re-run with|To write into this window)/)[0]!.trim();
}

/** The agent says which way it wants to see ("down" = further down the page).
 *  Peekaboo names the direction the content moves, which is the opposite. */
export function wheelDirection(direction: string): string | undefined {
  return ({ down: 'up', up: 'down', right: 'left', left: 'right' } as Record<string, string>)[direction];
}

const quiet = (limits: string) => ({ type: 'boolean', description: `Deliver to the looked-at window without moving the pointer or bringing the window forward, so nobody using the Mac is interrupted. Needs a look at an app window. ${limits} When it fails the error says so: look to see whether anything changed, then repeat without quiet.` });

const xy = {
  x: { type: 'number', description: 'Pixels from the left edge of the last screen_look image.' },
  y: { type: 'number', description: 'Pixels from the top edge of the last screen_look image.' },
};

export const inputToolDefinitions = [
  { name: 'screen_click',
    description: 'Click with the real mouse at x,y in your last screen_look image. Works on any app. If that look was of an app window, the window is brought to the front first; if it was of the whole screen or a region, the click lands on whatever is there. The pointer moves, so this takes the pointer and keyboard focus from anyone else using the Mac. Menus, file pickers and other pop-ups are separate windows: look at the screen to see and click them. The result is text only, so look again to see what changed.',
    inputSchema: { type: 'object' as const, properties: {
      ...xy,
      button: { type: 'string', enum: ['left', 'right'], description: 'Default left.' },
      double: { type: 'boolean', description: 'Double-click.' },
      quiet: quiet('Only standard controls accept it (buttons, links, fields, tabs); blank or custom-drawn areas, and page content in many browsers, refuse it. Single left clicks only.'),
    }, required: ['x', 'y'] } },
  { name: 'screen_type',
    description: 'Type text on the real keyboard, into whatever has keyboard focus. Click a field first to focus it. If your last screen_look was of an app window, that window is brought to the front first.',
    inputSchema: { type: 'object' as const, properties: {
      text: { type: 'string', description: 'The text to type.' },
      quiet: quiet('The text goes to whatever has keyboard focus inside that window.'),
    }, required: ['text'] } },
  { name: 'screen_press',
    description: 'Press keys on the real keyboard: "return", "tab", "escape", "delete", "space", "up", "down", "pagedown", and shortcuts such as "cmd+a", "cmd+c", "cmd+v", "cmd+w", "cmd+shift+g". Several separated by spaces are pressed in order. They go to whatever has keyboard focus; if your last screen_look was of an app window, that window is brought to the front first.',
    inputSchema: { type: 'object' as const, properties: {
      keys: { type: 'string', description: 'One key or shortcut, or several separated by spaces.' },
      quiet: quiet('Plain keys work (return, tab, pagedown); shortcuts with cmd reach the page, but the app does not act on them.'),
    }, required: ['keys'] } },
  { name: 'screen_scroll',
    description: 'Scroll with the mouse wheel at x,y in your last screen_look image. direction is the way you want to see: "down" shows what is further down.',
    inputSchema: { type: 'object' as const, properties: {
      ...xy,
      direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] },
      amount: { type: 'number', description: 'Wheel ticks (default 5).' },
    }, required: ['x', 'y', 'direction'] } },
  { name: 'screen_drag',
    description: 'Press the mouse button at x,y, drag to toX,toY and release, all in your last screen_look image. For sliders, scrollbars, moving things and selecting text.',
    inputSchema: { type: 'object' as const, properties: {
      ...xy,
      toX: { type: 'number', description: 'Where to release: pixels from the left edge.' },
      toY: { type: 'number', description: 'Where to release: pixels from the top edge.' },
    }, required: ['x', 'y', 'toX', 'toY'] } },
];
