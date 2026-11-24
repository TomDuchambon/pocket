'use strict';
// Pocket for agents. Claude, Cursor or any other MCP client reaches Pocket through mcp.js,
// which talks to this over a private socket in Pocket's own folder (only you can open it, and
// nothing listens on the network). Four things: set the scene, look, act, and read what the
// page did. It's the phone in your window, so everything an agent does plays out where you
// can watch it.

const fs = require('fs');
const net = require('net');

const WORLD = 4242; // a world of our own inside the page: the page's scripts never see these helpers
const SESSION = Math.random().toString(36).slice(2, 10); // tells mcp.js when Pocket has restarted
const SPEEDS = { fast: 1, 'mid-range': 4, budget: 6 };
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => {
  const text = String(s);
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};
async function waitUntil(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {
      // the page may be busy navigating; ask again
    }
    await sleep(60);
  }
  return false;
}

// ---- inside the page ----

// Runs in the page, in a world of its own, and only reads (except `select` and the scroll a
// `find` may do to bring its target into view). Positions are page points: the screen shows
// page rows `pan` to `pan + visible`; while the keyboard covers the page, the rows below that,
// down to the bottom of the page's frame, are under it.
function pageTools(args) {
  const { op, pan = 0, visible = innerHeight, covered = false } = args;
  const NO_KEYBOARD = /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit|date|datetime-local|month|time|week)$/;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const typable = (el) => !!el && !el.disabled && !el.readOnly && (el.isContentEditable || el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !NO_KEYBOARD.test((el.type || 'text').toLowerCase())));
  // The element with focus, looking inside shadow roots and frames from the same site.
  const focusedEl = () => {
    let el = document.activeElement;
    for (;;) {
      if (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      else if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME') && el.contentDocument) el = el.contentDocument.activeElement;
      else return el;
    }
  };
  const roleOf = (el) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (/^(button|submit|reset|image)$/.test(t)) return 'button';
      if (t === 'search') return 'searchbox';
      if (/^(date|time|datetime-local|month|week|color|file)$/.test(t)) return `${t} picker`;
      return 'textbox';
    }
    return 'clickable';
  };
  const nameOf = (el) => {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = norm(ids.split(/\s+/).map((id) => {
        const n = el.ownerDocument.getElementById(id);
        return n ? n.textContent : '';
      }).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = norm([...el.labels].map((l) => l.innerText || l.textContent).join(' '));
      if (t) return t;
    }
    const tag = el.tagName;
    const type = (el.type || '').toLowerCase();
    if (tag === 'INPUT' && /^(button|submit|reset)$/.test(type)) return norm(el.value) || type;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return norm(el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '');
    }
    const text = norm(el.innerText);
    if (text) return text;
    const pic = el.querySelector('img[alt], [aria-label], [title]');
    return norm(el.getAttribute('title') || (pic && (pic.getAttribute('alt') || pic.getAttribute('aria-label') || pic.getAttribute('title'))) || '');
  };
  const valueOf = (el) => {
    const tag = el.tagName;
    if (tag === 'SELECT') return el.selectedOptions && el.selectedOptions[0] ? norm(el.selectedOptions[0].text) : '';
    if (tag === 'TEXTAREA') return el.value;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (/^(checkbox|radio|button|submit|reset|image|file|hidden)$/.test(t)) return null;
      if (t === 'password') return el.value ? '•'.repeat(Math.min(el.value.length, 8)) : '';
      return el.value;
    }
    if (el.isContentEditable) return norm(el.innerText);
    return null;
  };
  const statesOf = (el) => {
    const s = [];
    if (el === focusedEl()) s.push('focused');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
    const type = (el.type || '').toLowerCase();
    const checked = el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')
      ? String(el.checked)
      : el.getAttribute('aria-checked') || el.getAttribute('aria-pressed');
    if (checked === 'true') s.push('checked');
    else if (checked === 'false') s.push('unchecked');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) s.push(expanded === 'true' ? 'expanded' : 'collapsed');
    const current = el.getAttribute('aria-current');
    if (current && current !== 'false') s.push('current');
    return s;
  };

  // The cheap questions first: none of them needs the whole page read.
  if (op === 'focus') {
    const el = focusedEl();
    if (!typable(el)) return { typable: false };
    const v = valueOf(el);
    return { typable: true, role: roleOf(el), name: cut(nameOf(el), 80), value: v == null ? '' : v };
  }
  if (op === 'select') {
    const el = focusedEl();
    if (el && typeof el.select === 'function') {
      el.select();
      return true;
    }
    if (el && el.isContentEditable) {
      const doc = el.ownerDocument;
      const r = doc.createRange();
      r.selectNodeContents(el);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    }
    return false;
  }
  if (op === 'has') return norm(document.body ? document.body.innerText : '').toLowerCase().includes(norm(args.text).toLowerCase());
  if (op === 'scrollpos') return { x: Math.round(scrollX), y: Math.round(scrollY) };

  // Everything else reads the page: what can be tapped, and the text around it.
  const W = innerWidth;
  const H = innerHeight;
  const ROLES = ['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'slider', 'textbox', 'searchbox', 'combobox', 'spinbutton'];
  const CONTROL = ['a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary', '[contenteditable=""]',
    '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])', ...ROLES.map((r) => `[role=${r}]`)].join(',');
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE|HEAD|META|LINK)$/;
  const HEADING = 'h1,h2,h3,h4,h5,h6,[role=heading]';
  const styles = new Map();
  const style = (el) => {
    if (!styles.has(el)) styles.set(el, getComputedStyle(el));
    return styles.get(el);
  };
  const shown = (el) => (el.checkVisibility
    ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : el.getClientRects().length > 0);
  // on: on screen, above any keyboard; under: covered by the keyboard; the rest is scrolled away.
  const where = (r) => {
    if (!r || r.width < 1 || r.height < 1) return 'none';
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || x > W) return 'aside';
    if (y < pan) return 'above';
    if (y <= pan + visible) return 'on';
    if (covered && y <= H) return 'under';
    return 'below';
  };

  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  const controls = [];
  const isControl = new Set();
  for (const el of all) {
    if (SKIP.test(el.tagName) || el === document.documentElement || el === document.body) continue;
    let control = el.matches(CONTROL);
    if (!control) {
      // Tappable things built from plain elements (a card, say) give themselves away with a
      // pointer cursor; only the outermost one counts, and not if a real control is inside.
      const parent = el.parentElement;
      control = style(el).cursor === 'pointer' && !(parent && style(parent).cursor === 'pointer') && !el.querySelector(CONTROL);
    }
    if (!control || !shown(el)) continue;
    controls.push(el);
    isControl.add(el);
  }
  const controlOf = (el) => {
    for (let p = el; p; p = p.parentElement) if (isControl.has(p)) return p;
    return null;
  };
  // Text, gathered by the block it sits in, so "41 <b>ships</b> waiting" reads as one line.
  const blockOf = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (p === document.body) return p;
      const d = style(p).display;
      if (d !== 'contents' && !d.startsWith('inline')) return p;
    }
    return el;
  };
  const blocks = new Map();
  const range = document.createRange();
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = norm(n.data);
    const p = n.parentElement;
    if (!t || !p || SKIP.test(p.tagName) || controlOf(p) || !shown(p)) continue;
    const lab = p.closest('label');
    if (lab && lab.control) continue; // a field's label already names it
    const heading = p.closest(HEADING);
    const key = heading || blockOf(p);
    const b = blocks.get(key);
    if (b) {
      b.text += ` ${t}`;
      continue;
    }
    range.selectNodeContents(n);
    blocks.set(key, { text: t, rect: range.getBoundingClientRect(), heading: Boolean(heading) });
  }

  const describe = (el, r = el.getBoundingClientRect()) => {
    const o = isControl.has(el)
      ? { role: roleOf(el), name: cut(nameOf(el), 80) }
      : { role: el.matches(HEADING) ? 'heading' : 'text', name: cut(norm(el.innerText || el.textContent), 120) };
    o.x = Math.round(r.left + r.width / 2);
    o.y = Math.round(r.top + r.height / 2 - pan);
    const v = isControl.has(el) ? valueOf(el) : null;
    if (v != null && v !== '') o.value = cut(norm(v), 60);
    const s = statesOf(el);
    if (s.length) o.states = s;
    return o;
  };
  // Whatever sits on top of an element's middle, if it isn't the element itself (an overlay, say).
  const coverOf = (el, r) => {
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : document).elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
    const cls = typeof hit.className === 'string' && hit.className.trim() ? `.${hit.className.trim().split(/\s+/)[0]}` : '';
    return hit.tagName.toLowerCase() + (hit.id ? `#${hit.id}` : '') + cls;
  };

  if (op === 'look') {
    const items = [];
    for (const el of controls) items.push({ el, r: el.getBoundingClientRect() });
    for (const [el, b] of blocks) items.push({ el, r: b.rect, text: b.text, heading: b.heading });
    items.sort((a, b) => Math.round(a.r.top / 6) - Math.round(b.r.top / 6) || a.r.left - b.r.left);
    const on = [];
    const under = [];
    const off = { above: 0, below: 0, aside: 0 };
    for (const it of items) {
      const w = where(it.r);
      if (w === 'none') continue;
      if (w !== 'on' && w !== 'under') {
        off[w]++;
        continue;
      }
      const o = it.text === undefined
        ? describe(it.el, it.r)
        : { role: it.heading ? 'heading' : 'text', name: cut(it.text, 160) };
      if (it.text === undefined && w === 'on') {
        const c = coverOf(it.el, it.r);
        if (c) o.coveredBy = c;
      }
      const list = w === 'on' ? on : under;
      const last = list[list.length - 1];
      if (last && last.role === o.role && last.name === o.name && o.role === 'text') continue;
      list.push(o);
    }
    return { on: on.slice(0, 150), more: Math.max(0, on.length - 150), under: under.slice(0, 40), off };
  }

  if (op === 'at') {
    const hit = document.elementFromPoint(args.x, args.y);
    if (!hit) return null;
    const control = controlOf(hit);
    if (control) return describe(control);
    const text = cut(norm(hit.innerText || hit.textContent), 60);
    return { role: text ? 'text' : hit.tagName.toLowerCase(), name: text };
  }

  if (op === 'find') {
    const target = String(args.target || '');
    const want = norm(target).toLowerCase();
    const named = (test) => controls.filter((el) => test(nameOf(el).toLowerCase()));
    let matches = [];
    if (want) {
      matches = named((n) => n === want);
      if (!matches.length) matches = named((n) => n.startsWith(want));
      if (!matches.length) matches = named((n) => n.includes(want));
      if (!matches.length) {
        const exact = [];
        const partial = [];
        for (const [el, b] of blocks) {
          const t = b.text.toLowerCase();
          if (t === want) exact.push(el);
          else if (t.includes(want)) partial.push(el);
        }
        matches = exact.length ? exact : partial;
      }
    }
    if (!matches.length) {
      try {
        matches = [...document.querySelectorAll(target)].filter(shown);
      } catch (e) {
        // not a CSS selector either
      }
    }
    if (!matches.length) {
      const here = controls.filter((el) => where(el.getBoundingClientRect()) === 'on').slice(0, 15)
        .map((el) => `${roleOf(el)} "${cut(nameOf(el), 40)}"`);
      return { found: false, onScreen: here };
    }
    // What's on screen first, then what's under the keyboard, then what a scroll would bring in.
    const rank = { on: 0, under: 1, above: 2, below: 2, aside: 3, none: 4 };
    matches.sort((a, b) => rank[where(a.getBoundingClientRect())] - rank[where(b.getBoundingClientRect())]);
    const el = matches[0];
    let scrolled = false;
    if (args.scroll && where(el.getBoundingClientRect()) !== 'on') {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      scrolled = true;
    }
    const r = el.getBoundingClientRect();
    const w = where(r);
    return {
      found: true,
      ...describe(el, r),
      where: w,
      px: r.left + r.width / 2,
      py: r.top + r.height / 2,
      width: Math.round(r.width),
      height: Math.round(r.height),
      matches: matches.length,
      scrolled,
      coveredBy: w === 'on' ? coverOf(el, r) : null,
    };
  }
  return null;
}

// ---- the agent ----

function makeAgent(pocket) {
  const page = () => pocket.page();
  const send = (method, params = {}) => page().debugger.sendCommand(method, params);
  const inPage = async (args) => {
    const code = `(() => { try { return (${pageTools})(${JSON.stringify(args)}); } catch (e) { return { pageToolsError: String(e && e.message || e) }; } })()`;
    let result;
    try {
      result = await page().executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
    } catch (err) {
      throw new Error(`Couldn't read the page just now (${err.message}). Try again once it has loaded.`);
    }
    if (result && result.pageToolsError) throw new Error(`Couldn't read the page: ${result.pageToolsError}`);
    return result;
  };

  // The screen right now, in page points: rows pan..pan+visible sit above any keyboard.
  const view = () => {
    const s = pocket.sceneInfo();
    const k = pocket.keyboard();
    const kbH = k.visible ? k.height : 0;
    return { s, k, w: s.w, h: s.h, up: k.visible, covered: k.visible && !k.squeeze, pan: k.visible ? k.pan || 0 : 0, visible: s.h - kbH, kbH };
  };
  const frame = (v) => ({ pan: v.pan, visible: v.visible, covered: v.covered });

  // ---- words ----

  const place = (url) => {
    try {
      const u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.host + u.pathname + u.search : url;
    } catch {
      return url;
    }
  };
  const label = (f) => (f.role === 'text' ? `"${f.name}"` : `${f.role} ${f.name ? `"${f.name}"` : '(no label)'}`);
  const KINDS = { numeric: 'number pad', phone: 'phone pad', email: 'email', url: 'web address', text: 'text' };
  const STYLES = { apple: 'Apple', samsung: 'Samsung', gboard: 'Gboard' };
  const keyboardLine = (v) => {
    if (!v.up) return 'Keyboard: down.';
    const what = `${STYLES[v.k.style]}, ${KINDS[v.k.kind] || v.k.kind}`;
    if (v.k.squeeze) return `Keyboard: up (${what}). This app shrinks the page to the ${v.visible} points above it.`;
    const slid = v.pan ? ` The page is slid up ${v.pan} points so the field shows.` : '';
    return `Keyboard: up (${what}), covering the bottom ${v.kbH} of ${v.h} points, so ${v.visible} points of page show above it.${slid}`;
  };
  const pageLine = (s) => (s.waiting
    ? `Waiting for ${place(s.url)}: it isn't answering yet, and Pocket loads it the moment it does.`
    : `${place(s.url)}${s.title ? ` · "${s.title}"` : ''}`);
  const nowLine = (s) => (s.waiting
    ? `Waiting for ${place(s.url)}, which isn't answering yet.`
    : `Now on ${place(s.url)}${s.title ? ` ("${s.title}")` : ''}.`);
  const itemLine = (o) => {
    if (o.role === 'text') return `  "${o.name}"`;
    if (o.role === 'heading') return `  heading "${o.name}"`;
    let line = `  ${o.role} ${o.name ? `"${o.name}"` : '(no label)'}`;
    if (o.value !== undefined) line += ` = "${o.value}"`;
    if (o.states) line += ` [${o.states.join(', ')}]`;
    if (o.x !== undefined) line += ` at ${o.x},${o.y}`;
    if (o.coveredBy) line += ` (covered by ${o.coveredBy})`;
    return line;
  };
  const json = (o) => cut(JSON.stringify(o), 600);
  const props = (r) => (r.data && Object.keys(r.data).length ? ` ${json(r.data)}` : '');
  const clock = (t) => new Date(t).toTimeString().slice(0, 8);
  const rowLine = (r) => {
    if (r.kind === 'nav') return `${clock(r.time)}  page     ${r.where}`;
    if (r.kind === 'event') return `${clock(r.time)}  event    ${r.title}${props(r)}${r.detail ? `  on ${r.detail}` : ''}`;
    const kind = r.kind === 'error' ? 'error  ' : 'request';
    return `${clock(r.time)}  ${kind}  ${r.title}${r.detail ? `  (${r.detail})` : ''}`;
  };
  const firedLine = (rows) => {
    if (!rows.length) return 'Nothing fired.';
    const bits = rows.slice(0, 12).map((r) => {
      if (r.kind === 'nav') return `page ${r.where}`;
      if (r.kind === 'event') return `event "${r.title}"${props(r)}`;
      return `${r.kind} "${cut(r.title, 120)}"${r.detail ? ` (${cut(r.detail, 80)})` : ''}`;
    });
    const more = rows.length > 12 ? `; and ${rows.length - 12} more (see activity)` : '';
    return `Fired: ${bits.join('; ')}${more}.`;
  };

  // ---- scene ----

  async function scene(args) {
    const o = pocket.options;
    const pick = (name, value, allowed) => {
      if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
      return value;
    };
    const next = {};
    if (args.persona !== undefined) next.persona = pick('persona', args.persona, [...o.personas, 'none']) === 'none' ? null : args.persona;
    if (args.device !== undefined) next.device = pick('device', args.device, o.devices);
    if (args.app !== undefined) next.mode = pick('app', args.app, o.apps);
    if (args.network !== undefined) next.network = pick('network', args.network, o.networks);
    if (args.phone_speed !== undefined) next.cpu = SPEEDS[pick('phone_speed', args.phone_speed, Object.keys(SPEEDS))];
    if (args.keyboard !== undefined) next.keyboard = pick('keyboard', args.keyboard, o.keyboards);
    if (args.landscape !== undefined) next.landscape = Boolean(args.landscape);
    const changed = Object.keys(next).length > 0;
    if (changed) {
      pocket.flash('Agent: new scene');
      await pocket.applyScene(next);
      await pocket.settle(12000);
    }
    const s = pocket.sceneInfo();
    const speed = Object.keys(SPEEDS).find((k) => SPEEDS[k] === s.cpu);
    return {
      text: [
        changed ? 'Done. The scene now:' : 'The scene:',
        `Phone: ${s.phone}${s.landscape ? ', sideways' : ''} (device: ${s.device}, landscape: ${s.landscape})`,
        `Opened in: ${s.browser} (app: ${s.app})`,
        `Person: ${s.who} (persona: ${s.persona})`,
        `Network: ${s.networkLabel} (network: ${s.network}). Phone speed: ${s.phoneSpeed} (phone_speed: ${speed})`,
        `Keyboard: ${s.keyboardLabel} (keyboard: ${s.keyboard})`,
        `Page: ${s.waiting ? `waiting for ${s.url}, which isn't answering yet` : s.url}`,
      ].join('\n'),
    };
  }

  // ---- look ----

  async function look({ image = 'normal', wait_for: waitFor } = {}) {
    if (!['normal', 'sharp', 'none'].includes(image)) throw new Error('image must be normal, sharp or none.');
    const lines = [];
    if (waitFor) {
      const t0 = Date.now();
      let seen = false;
      while (!seen && Date.now() - t0 < 45000) {
        seen = await inPage({ op: 'has', text: waitFor }).catch(() => false);
        if (!seen) await sleep(300);
      }
      lines.push(seen
        ? `"${waitFor}" showed up after ${((Date.now() - t0) / 1000).toFixed(1)} s.`
        : `Still no "${waitFor}" after 45 s. This is the page as it is now.`);
      if (seen) await pocket.settle(3000);
    }
    const v = view();
    const s = v.s;
    lines.push(pageLine(s));
    const conditions = [s.persona !== 'none' && s.who, s.network !== 'none' && s.networkLabel, s.cpu !== 1 && s.phoneSpeed].filter(Boolean);
    lines.push(`${s.phone}${s.landscape ? ', sideways' : ''} · ${s.browser}${conditions.length ? ` · ${conditions.join(' · ')}` : ''}`);
    lines.push(keyboardLine(v));
    let png = null;
    if (image !== 'none') {
      png = await pocket.capture(image === 'sharp' ? 0 : v.w);
      lines.push(image === 'sharp'
        ? `Screenshot at the phone's full resolution, ${s.dpr} pixels per point: divide by ${s.dpr} for a tap point.`
        : `Screenshot: ${v.w}×${v.h}, one pixel per point, so an x,y on it is a tap point.`);
    }
    if (!s.waiting && /^https?:/.test(s.url)) {
      const d = await inPage({ op: 'look', ...frame(v) }).catch((err) => {
        lines.push('', err.message);
        return null;
      });
      if (d) {
        lines.push('', 'On screen, top to bottom:', ...(d.on.length ? d.on.map(itemLine) : ['  (nothing)']));
        if (d.more) lines.push(`  …and ${d.more} more`);
        if (d.under.length) lines.push('', 'Under the keyboard (out of reach until it goes down):', ...d.under.map(itemLine));
        const off = [d.off.below && `${d.off.below} further down`, d.off.above && `${d.off.above} further up`, d.off.aside && `${d.off.aside} off to the side`].filter(Boolean);
        if (off.length) lines.push('', `Off screen: ${off.join(', ')}.`);
      }
    }
    return { text: lines.join('\n'), image: png ? png.toString('base64') : undefined };
  }

  // ---- act ----

  async function touch(x, y) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }] });
    await sleep(60);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  // A finger drag, the way a thumb scrolls a page, pans a map or pulls a sheet. It comes to rest
  // before lifting, so nothing flings on past the distance asked for.
  async function drag(x0, y0, x1, y1) {
    const steps = 10;
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= steps; i++) {
      const p = { x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps };
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
      await sleep(16);
    }
    await sleep(150);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async function keyEvent(k) {
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await send('Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async function typeChar(ch) {
    if (!/^[\x20-\x7e]$/.test(ch)) return send('Input.insertText', { text: ch }); // accents, emoji, other scripts
    const vk = /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : /\d/.test(ch) ? ch.charCodeAt(0) : ch === ' ' ? 32 : 0;
    const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: ch, unmodifiedText: ch });
    await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    return undefined;
  }

  const parsePoint = (target) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(target);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };

  // Finds what an action is aimed at, scrolled into view, and refuses what a person couldn't reach.
  async function locate(target, v) {
    const f = await inPage({ op: 'find', target, scroll: true, ...frame(v) });
    if (!f || !f.found) {
      const here = f && f.onScreen && f.onScreen.length ? ` On screen now: ${f.onScreen.join(', ')}.` : '';
      throw new Error(`Nothing on the page matches "${target}".${here}`);
    }
    if (f.where === 'under') {
      throw new Error(`${label(f)} is under the keyboard, where a person couldn't tap it. Press Done to put the keyboard away first.`);
    }
    if (f.where !== 'on') throw new Error(`${label(f)} is off screen${f.scrolled ? ', and scrolling to it didn\'t bring it into view' : ''}.`);
    return f;
  }

  async function tap(target) {
    if (!target) throw new Error('tap needs a target: a visible label or text, a CSS selector, or x,y from the screenshot.');
    const v = view();
    const point = parsePoint(target);
    let x;
    let y;
    let what;
    let note = '';
    if (point) {
      if (point.x > v.w || point.y > v.h) throw new Error(`${target} is off the screen, which is ${v.w}×${v.h}.`);
      if (v.up && point.y > v.visible) throw new Error(`${target} is on the keyboard. Use type to enter text, or press Done to put the keyboard away.`);
      x = point.x;
      y = point.y + v.pan;
      const hit = await inPage({ op: 'at', x, y });
      what = hit ? label(hit) : 'an empty spot';
    } else {
      const f = await locate(target, v);
      x = f.px;
      y = f.py;
      what = label(f);
      if (f.scrolled) note += ', after scrolling it into view';
      if (f.matches > 1) note += ` (${f.matches} things matched; this was the first one in sight)`;
      if (f.coveredBy) note += `. Careful: ${f.coveredBy} sits on top of it, so the tap landed on that`;
    }
    await touch(x, y);
    pocket.flash(`Agent tapped ${cut(what, 40)}`);
    return `Tapped ${what} at ${Math.round(x)},${Math.round(y - v.pan)}${note}.`;
  }

  async function type(text, target) {
    if (typeof text !== 'string') throw new Error('type needs text.');
    if (target) {
      await tap(target);
      await waitUntil(async () => (await inPage({ op: 'focus' })).typable, 1500);
    }
    const f = await inPage({ op: 'focus' });
    if (!f.typable) {
      throw new Error(target ? `Tapping "${target}" didn't put the cursor in a text field.` : 'No text field has the cursor. Give a target to tap first.');
    }
    if (target) {
      await inPage({ op: 'select' }); // what's typed replaces what was there
      if (!text) await keyEvent(KEYS.Backspace);
    }
    for (const ch of text) {
      if (ch === '\n') await keyEvent(KEYS.Enter);
      else await typeChar(ch);
      pocket.lightKey(ch === '\n' ? 'Enter' : ch);
      await sleep(14);
    }
    pocket.flash(`Agent typed into ${cut(f.name || f.role, 30)}`);
    const after = await inPage({ op: 'focus' }).catch(() => ({ typable: false }));
    const reads = after.typable ? ` It now reads "${cut(after.value, 120)}".` : '';
    return `Typed ${JSON.stringify(cut(text, 80))} into ${label(f)}${target ? ', replacing what was there' : ''}.${reads}`;
  }

  async function press(key) {
    if (key === 'Done') {
      if (!pocket.keyboard().visible) return 'The keyboard was already down.';
      await pocket.dismissKeyboard();
      await waitUntil(() => !pocket.keyboard().visible, 1500);
      pocket.flash('Agent put the keyboard away');
      return 'Put the keyboard away (Done).';
    }
    const k = KEYS[key];
    if (!k) throw new Error(`key must be one of: ${[...Object.keys(KEYS), 'Done'].join(', ')}.`);
    await keyEvent(k);
    pocket.lightKey(k.key);
    pocket.flash(`Agent pressed ${key}`);
    return `Pressed ${key}.`;
  }

  async function scroll(direction, target) {
    if (!['down', 'up', 'left', 'right'].includes(direction)) throw new Error('direction must be down, up, left or right.');
    const v = view();
    let x = v.w / 2;
    let y = v.pan + v.visible / 2;
    let spanX = v.w;
    let spanY = v.visible;
    let what = 'the page';
    if (target) {
      const f = await locate(target, v);
      x = f.px;
      y = f.py;
      spanX = Math.min(f.width, v.w);
      spanY = Math.min(f.height, v.visible);
      what = label(f);
    }
    // A finger drag across the middle of the area: up to see further down, and so on.
    const across = direction === 'left' || direction === 'right';
    const dist = Math.max(40, Math.round((across ? spanX : spanY) * 0.6));
    const half = ((direction === 'down' || direction === 'right' ? 1 : -1) * dist) / 2;
    const before = await inPage({ op: 'scrollpos' });
    if (across) await drag(x + half, y, x - half, y);
    else await drag(x, y + half, x, y - half);
    pocket.flash(`Agent scrolled ${direction}`);
    if (target) return `Swiped ${direction} on ${what}.`;
    const after = await inPage({ op: 'scrollpos' });
    const moved = Math.abs(across ? after.x - before.x : after.y - before.y);
    return moved
      ? `Scrolled ${direction}: the page moved ${moved} points.`
      : `Swiped ${direction}, but the page didn't move (it's at the end, or it doesn't scroll that way).`;
  }

  async function openUrl(raw) {
    if (!raw) throw new Error('open needs a url: a full address, a port like 3000, or a path like /map.');
    pocket.flash(`Agent opened ${cut(raw, 40)}`);
    await pocket.open(raw);
    const s = pocket.sceneInfo();
    return s.waiting
      ? `${place(s.url)} isn't answering yet (is the dev server running?). Pocket keeps trying and loads it the moment it's up.`
      : `Opened ${s.url}.`;
  }

  async function back() {
    const history = page().navigationHistory;
    if (!history.canGoBack()) throw new Error('There is nothing to go back to.');
    pocket.flash('Agent went back');
    history.goBack();
    return 'Went back.';
  }

  async function act(args) {
    const before = pocket.lastActivityId();
    let did;
    let wait = 4000;
    switch (args.action) {
      case 'open': did = await openUrl(args.url); wait = 15000; break;
      case 'tap': did = await tap(args.target); break;
      case 'type': did = await type(args.text, args.target); break;
      case 'press': did = await press(args.key); break;
      case 'scroll': did = await scroll(args.direction || 'down', args.target); break;
      case 'back': did = await back(); wait = 12000; break;
      case 'reload': pocket.reload(); did = 'Reloaded.'; wait = 15000; break;
      default: throw new Error('action must be one of: open, tap, type, press, scroll, back, reload.');
    }
    const settled = await pocket.settle(wait);
    const v = view();
    const busy = settled ? '' : ` Still loading: ${pocket.inflight()} request${pocket.inflight() === 1 ? '' : 's'} open.`;
    return { text: [did, `${nowLine(v.s)} ${keyboardLine(v)}${busy}`, firedLine(pocket.activity(before))].join('\n') };
  }

  // ---- activity ----

  function activity({ after = 0, session } = {}) {
    const since = session === SESSION ? after : 0; // Pocket restarted since the last check: it's all new
    const rows = pocket.activity(since);
    const result = { lastId: pocket.lastActivityId(), session: SESSION };
    if (!rows.length) return { ...result, text: since ? 'Nothing new since your last check.' : 'Nothing has happened yet.' };
    const shown = rows.slice(-150);
    const c = pocket.counts();
    const text = [
      since ? 'Since your last check, oldest first:' : 'Everything so far, oldest first:',
      ...(rows.length > shown.length ? [`(${rows.length - shown.length} older ones left out)`] : []),
      ...shown.map(rowLine),
      '',
      `On the page now: ${c.events} event${c.events === 1 ? '' : 's'}, ${c.errors} error${c.errors === 1 ? '' : 's'} since it loaded.`,
    ].join('\n');
    return { ...result, text };
  }

  return async function run(tool, args = {}) {
    if (tool === 'scene') return scene(args);
    if (tool === 'look') return look(args);
    if (tool === 'act') return act(args);
    if (tool === 'activity') return activity(args);
    throw new Error(`Pocket has no tool called ${tool}.`);
  };
}

// ---- the socket ----

// One JSON request per line in, one JSON answer per line out, one request at a time (two
// agents at once take turns rather than tapping over each other).
module.exports = function serveAgents(socketPath, pocket) {
  const run = makeAgent(pocket);
  let queue = Promise.resolve();
  try {
    fs.unlinkSync(socketPath); // left behind if Pocket didn't quit cleanly
  } catch {
    // nothing there
  }
  const server = net.createServer((sock) => {
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4e6) {
        sock.destroy();
        return;
      }
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        queue = queue.then(async () => {
          let res;
          try {
            res = { id: req.id, ok: true, ...(await run(req.tool, req.args || {})) };
          } catch (err) {
            res = { id: req.id, ok: false, error: err.message };
          }
          if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`);
        });
      }
    });
  });
  server.on('error', (err) => console.error(`Pocket's agent socket: ${err.message}`));
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600); // yours alone
    } catch {
      // still private to the folder
    }
  });
  return {
    close() {
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // already gone
      }
    },
  };
};
