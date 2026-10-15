// Runs the display commands Muse invokes (the bridge validated them already; the page checks
// again, because demo mode calls these directly). Each returns a link.result: { ok, payload }
// or { ok: false, error }, which goes back to Muse as the command's answer.

import { EXPRESSIONS, GESTURES } from './avatar.js';
import { SHAPES, THEMES } from './stage.js';

const fail = (error) => ({ ok: false, error });
const done = (payload = {}) => ({ ok: true, payload });

export function createCommands({ avatar, stage, display, sayLocally }) {
  const handlers = {
    'avatar.express'({ expression, seconds = 4 }) {
      if (!EXPRESSIONS.includes(expression)) return fail(`unknown expression ${expression}`);
      avatar.setExpression(expression, seconds);
      return done({ expression });
    },
    'avatar.gesture'({ gesture }) {
      if (!GESTURES.includes(gesture)) return fail(`unknown gesture ${gesture}`);
      avatar.playGesture(gesture);
      return done({ gesture });
    },
    'avatar.say'({ text, expression }) {
      if (!text) return fail('text is required');
      if (expression && EXPRESSIONS.includes(expression)) avatar.setExpression(expression, 6);
      sayLocally(String(text).slice(0, 2000));
      return done({ spoken: true, voice: 'local' });
    },
    async 'display.show_image'({ url, data_base64, mime_type, caption }) {
      const src = url || (data_base64 ? `data:${mime_type};base64,${data_base64}` : null);
      if (!src) return fail('give url or data_base64');
      try {
        await stage.showImage(src, caption);
      } catch {
        return fail('The image could not be loaded. Use a public https URL that allows cross-origin requests.');
      }
      avatar.playGesture('point_right');
      return done({ showing: 'image', caption: caption || null });
    },
    async 'display.show_model'({ url, caption, spin = 1 }) {
      if (!url) return fail('url is required');
      try {
        await stage.showModel(url, caption, spin !== 0);
      } catch {
        return fail('The model could not be loaded. It must be a public glTF 2.0 file (.glb or .gltf) served with CORS.');
      }
      avatar.playGesture('point_right');
      return done({ showing: 'model', caption: caption || null });
    },
    'display.show_shape'({ shape, caption, color }) {
      if (!SHAPES.includes(shape)) return fail(`unknown shape ${shape}`);
      stage.showShape(shape, caption, color);
      avatar.playGesture('point_right');
      return done({ showing: shape });
    },
    'display.show_card'({ title, body, bullets, accent }) {
      if (!title) return fail('title is required');
      const list = Array.isArray(bullets) ? bullets : typeof bullets === 'string' ? bullets.split('\n').filter(Boolean) : [];
      stage.showCard({ title, body, bullets: list.slice(0, 6), accent: accent || '#8f7bff' });
      return done({ showing: 'card', title });
    },
    'display.clear'() {
      const had = stage.describe();
      stage.clear();
      return done({ cleared: had ? had.kind : null });
    },
    'display.set_depth'({ strength, pop }) {
      const result = display.setDepth({ strength, pop });
      return done(result);
    },
    async 'display.set_mode'({ mode }) {
      if (mode !== '3d' && mode !== '2d') return fail('mode must be "3d" or "2d"');
      return done(await display.setMode(mode));
    },
    'display.set_theme'({ theme }) {
      if (!THEMES[theme]) return fail(`unknown theme ${theme}`);
      stage.setTheme(theme);
      return done({ theme });
    },
    'display.status'() {
      return done({ ...display.status(), avatar: avatar.describe(), content: stage.describe(), theme: stage.themeName });
    },
  };

  return async function run(command, params = {}) {
    const handler = handlers[command];
    if (!handler) return fail(`this display does not know ${command}`);
    try {
      return await handler(params || {});
    } catch (e) {
      console.warn('[muse-avatar] command failed', command, e);
      return fail(e?.message || String(e));
    }
  };
}
