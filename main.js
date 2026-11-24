'use strict';
// Pocket: your localhost, pocket-sized.
// The same mobile emulation Chrome DevTools uses (viewport, touch,
// pointer: coarse, mobile user agent), in its own floating window.
//
//   pocket             http://localhost:3000
//   pocket 5173        http://localhost:5173
//   pocket /map        http://localhost:3000/map
//   pocket <url>       anything else
//
// Cmd+1 to Cmd+7 device, Cmd+L landscape, Cmd+Opt+1 to 3 browser / Instagram / Facebook,
// Cmd+E activity panel, Cmd+Shift+C copy screenshot, Cmd+R reload,
// Cmd+Shift+Delete clear cookies and storage, Cmd+[ back, Cmd+Shift+F float on top,
// Cmd+Alt+I DevTools. Personas and network/phone speed live in their menus. Typing into a
// field brings up the phone's own keyboard (the Keyboard menu switches it or turns it off).
//
// Agents (Claude, Cursor) drive the same phone through mcp.js; see agent.js.

const { app, BrowserWindow, ClipboardItem, Menu, WebContentsView, clipboard, nativeImage, net, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const serveAgents = require('./agent');

const DEFAULT_URL = 'http://localhost:3000';
const CHROME = process.versions.chrome.split('.')[0];

// ---- devices ----

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME}.0.0.0 Mobile Safari/537.36`;
// iPad Safari asks for desktop sites, so it really does say it's a Mac (with touch).
const IPAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const androidMeta = (brand, model) => ({
  brands: [
    { brand: 'Chromium', version: CHROME },
    { brand, version: CHROME },
    { brand: 'Not.A/Brand', version: '99' },
  ],
  platform: 'Android',
  platformVersion: '14.0.0',
  architecture: '',
  model,
  mobile: true,
});

const iphone = (label, width, height, dpr) =>
  ({ label, width, height, dpr, os: 'ios', code: 'iPhone16,2', platform: 'iPhone', ua: IOS_UA });
const android = (label, width, height, dpr, hw) =>
  ({ label, width, height, dpr, os: 'android', platform: 'Linux armv81', ua: ANDROID_UA, uaMeta: androidMeta('Google Chrome', ''), hw });

// The size range real phones actually span, smallest to largest, not a catalogue of models.
const DEVICES = {
  'iphone-se': iphone('iPhone SE', 375, 667, 2),
  iphone: iphone('iPhone', 393, 852, 3),
  'iphone-pro': iphone('iPhone Pro', 402, 874, 3),
  'iphone-pro-max': iphone('iPhone Pro Max', 440, 956, 3),
  android: android('Small Android', 360, 800, 3, { maker: 'samsung', model: 'SM-A155F', device: 'a15', chip: 'mt6789' }),
  pixel: android('Pixel', 412, 915, 2.625, { maker: 'Google/google', model: 'Pixel 9', device: 'tokay', chip: 'tokay' }),
  'ipad-mini': { label: 'iPad mini', width: 744, height: 1133, dpr: 2, os: 'ipados', code: 'iPad16,1', platform: 'MacIntel', ua: IPAD_UA },
};
const DEVICE_GROUPS = [
  ['iphone-se', 'iphone', 'iphone-pro', 'iphone-pro-max'],
  ['android', 'pixel'],
  ['ipad-mini'],
];

// ---- in-app browsers ----
// What people get when they tap a link inside Instagram or Facebook: the phone's WebView
// instead of Safari or Chrome, the app's tag on the end of its identity, a cookie jar of
// its own, and every link kept inside the app.

const IOS_WEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_WEBVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const androidWebview = (hw) =>
  `Mozilla/5.0 (Linux; Android 14; ${hw.model} Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${CHROME}.0.0.0 Mobile Safari/537.36`;
const pixels = (d) => `${Math.round(d.width * d.dpr)}x${Math.round(d.height * d.dpr)}`;
const appleKind = (d) => (d.os === 'ipados' ? 'iPad' : 'iPhone');

const MODES = {
  browser: { label: 'Browser' },
  instagram: {
    label: 'Instagram',
    ios: (d) => ` Instagram 400.0.0.27.80 (${d.code}; iOS 18_5; en_GB; en-GB; scale=${d.dpr.toFixed(2)}; ${pixels(d)}; 0)`,
    android: (d) => ` Instagram 400.0.0.27.80 Android (34/14; ${Math.round(d.dpr * 160)}dpi; ${pixels(d)}; ${d.hw.maker}; ${d.hw.model}; ${d.hw.device}; ${d.hw.chip}; en_GB; 0)`,
  },
  facebook: {
    label: 'Facebook',
    ios: (d) => ` [FBAN/FBIOS;FBAV/530.0.0.30.106;FBBV/0;FBDV/${d.code};FBMD/${appleKind(d)};FBSN/iOS;FBSV/18.5;FBSS/${d.dpr};FBID/${d.os === 'ipados' ? 'tablet' : 'phone'};FBLC/en_GB;FBOP/5]`,
    android: () => ' [FB_IAB/FB4A;FBAV/530.0.0.30.106;]',
  },
};
const MODE_ORDER = ['browser', 'instagram', 'facebook'];
// Each mode keeps its own cookies and storage, like the real apps do, and all of them
// survive relaunches.
const partitionFor = (m) => (m === 'browser' ? 'persist:pocket' : `persist:pocket-${m}`);

// ---- speed ----
// Chrome DevTools' own network presets, so numbers match what you'd see there.
const NETWORKS = {
  none: { label: 'No Throttling' },
  fast4g: { label: 'Fast 4G', detail: '9 Mbps', down: 9000 * 0.9, up: 1500 * 0.9, latency: 60 * 2.75 },
  slow4g: { label: 'Slow 4G', detail: '1.6 Mbps', down: 1600 * 0.9, up: 750 * 0.9, latency: 150 * 3.75 },
  '3g': { label: '3G', detail: '400 kbps', down: 500 * 0.8, up: 500 * 0.8, latency: 400 * 5 },
  offline: { label: 'Offline', offline: true },
};
const NETWORK_ORDER = ['none', 'fast4g', 'slow4g', '3g', 'offline'];
const PHONE_SPEEDS = {
  1: { label: 'Fast Phone' },
  4: { label: 'Mid-Range Phone', detail: '4× slower', short: 'Mid-range phone' },
  6: { label: 'Budget Phone', detail: '6× slower', short: 'Budget phone' },
};

// ---- personas ----
// One click sets the whole scene: phone, app, connection, phone speed, and where they
// are (language, clock and location stay on until you pick someone else).
const PERSONAS = {
  london: {
    label: 'London: iPhone in Safari', city: 'London',
    device: 'iphone', mode: 'browser', network: 'fast4g', cpu: 1,
    locale: 'en_GB', languages: 'en-GB,en;q=0.9', timezone: 'Europe/London', geo: [51.5072, -0.1276],
  },
  newyork: {
    label: 'New York: iPhone from an Instagram ad', city: 'New York',
    device: 'iphone-pro', mode: 'instagram', network: 'fast4g', cpu: 1,
    locale: 'en_US', languages: 'en-US,en;q=0.9', timezone: 'America/New_York', geo: [40.7128, -74.006],
  },
  lagos: {
    label: 'Lagos: Android from an Instagram ad', city: 'Lagos',
    device: 'android', mode: 'instagram', network: 'slow4g', cpu: 6,
    locale: 'en_NG', languages: 'en-NG,en;q=0.9', timezone: 'Africa/Lagos', geo: [6.5244, 3.3792],
  },
  mumbai: {
    label: 'Mumbai: Android from a Facebook ad', city: 'Mumbai',
    device: 'android', mode: 'facebook', network: '3g', cpu: 6,
    locale: 'en_IN', languages: 'en-IN,en;q=0.9,hi;q=0.8', timezone: 'Asia/Kolkata', geo: [19.076, 72.8777],
  },
};

// ---- keyboard ----
// The keyboard comes with the phone, not the browser: Apple's on iPhones and the iPad,
// Samsung's on the Galaxy-sized Android, Gboard on the Pixel. The menu can override it.
const KEYBOARDS = {
  auto: 'Match the Phone',
  apple: 'Apple Keyboard',
  samsung: 'Samsung Keyboard',
  gboard: 'Gboard',
  off: 'No Keyboard',
};
const KEYBOARD_ORDER = ['auto', 'apple', 'samsung', 'gboard', 'off'];

// Runs inside every page: tells Pocket when a field that brings up a keyboard gets or
// loses focus, and lets Pocket shrink the visible area the way Safari and Chrome do.
const KEYBOARD_HOOK = `(() => {
  if (window.__pocketKbInstalled) return;
  Object.defineProperty(window, '__pocketKbInstalled', { value: true });
  // The top page speaks for every frame, so two frames can never contradict each other.
  // A frame from the same site just passes its focus changes up; another site's frame
  // can't be read at all.
  if (window.top !== window) {
    try {
      const nudge = window.top.__pocketKbNudge;
      if (nudge) {
        document.addEventListener('focusin', () => nudge(0), true);
        document.addEventListener('focusout', () => nudge(60), true);
      }
    } catch (e) {}
    return;
  }
  const send = (o) => { try { window.__pocketKeyboard(JSON.stringify(o)); } catch (e) {} };
  const NO_KEYBOARD = /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit|date|datetime-local|month|time|week)$/;
  const typable = (el) => !!el && !el.disabled && !el.readOnly && (el.isContentEditable || el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !NO_KEYBOARD.test((el.type || 'text').toLowerCase())));
  const kindOf = (el) => {
    const mode = (el.getAttribute('inputmode') || '').toLowerCase();
    const type = (el.type || '').toLowerCase();
    if (mode === 'none') return null;
    if (mode === 'numeric' || mode === 'decimal' || type === 'number') return 'numeric';
    if (mode === 'tel' || type === 'tel') return 'phone';
    if (mode === 'email' || type === 'email') return 'email';
    if (mode === 'url' || type === 'url') return 'url';
    return 'text';
  };
  const enterOf = (el) => (el.getAttribute('enterkeyhint')
    || (el.type === 'search' ? 'search' : el.tagName === 'TEXTAREA' || el.isContentEditable ? 'enter' : el.form ? 'go' : 'enter')).toLowerCase();
  const squeezeAsked = () => /interactive-widget\\s*=\\s*resizes-content/i.test((document.querySelector('meta[name=viewport]') || {}).content || '');
  // The field that has focus, looking inside frames from the same site. Undefined when it's
  // inside another site's frame: that keeps the keyboard as it is (up from the last field,
  // say, when tabbing into a card number box).
  const focused = () => {
    let el = document.activeElement;
    while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      const doc = el.contentDocument;
      if (!doc) return undefined;
      el = doc.activeElement;
    }
    return el;
  };
  const report = () => {
    const el = focused();
    if (el === undefined) return;
    const kind = typable(el) ? kindOf(el) : null;
    send(kind ? { show: true, kind, enter: enterOf(el), squeezeAsked: squeezeAsked() } : { show: false });
  };
  // Focus arriving reports at once; focus leaving waits a moment, so hopping from one field
  // to the next doesn't flicker the keyboard.
  let timer = 0;
  const nudge = (ms) => {
    clearTimeout(timer);
    if (ms) timer = setTimeout(report, ms);
    else report();
  };
  document.addEventListener('focusin', () => nudge(0), true);
  document.addEventListener('focusout', () => nudge(60), true);
  Object.defineProperty(window, '__pocketKbNudge', { value: nudge });
  window.__pocketKbRefresh = report;
  // What the page sees of the keyboard: a shorter visible area (height), and a pan
  // (offsetTop) when the phone has to slide everything up to show the field.
  const vv = window.visualViewport;
  let inset = 0;
  let pan = 0;
  if (vv) {
    const proto = Object.getPrototypeOf(vv);
    const real = (prop) => Object.getOwnPropertyDescriptor(proto, prop);
    const height = real('height');
    Object.defineProperty(vv, 'height', { configurable: true, get() { return Math.max(0, height.get.call(vv) - inset); } });
    for (const prop of ['offsetTop', 'pageTop']) {
      const d = real(prop);
      if (d && d.get) Object.defineProperty(vv, prop, { configurable: true, get() { return d.get.call(vv) + pan; } });
    }
  }
  const setPan = (px) => {
    if (px === pan) return;
    pan = px;
    send({ pan });
    if (vv) vv.dispatchEvent(new Event('scroll'));
  };
  // Like the phone lifting the field above the keyboard: scroll first, then pan whatever
  // scrolling can't reach (a bar fixed to the bottom, or the very end of the page).
  const bottomOf = (el) => {
    let bottom = el.getBoundingClientRect().bottom;
    for (let w = el.ownerDocument.defaultView; w && w !== window && w.frameElement; w = w.parent) {
      bottom += w.frameElement.getBoundingClientRect().top;
    }
    return bottom;
  };
  // A field that's already in sight stays put (a composer standing on the keyboard, say).
  window.__pocketKbReveal = () => {
    const el = focused();
    if (!typable(el)) return;
    const visible = vv ? vv.height : innerHeight;
    let bottom = bottomOf(el);
    if (bottom > visible) {
      window.scrollBy({ top: bottom - visible + 24, behavior: 'instant' });
      bottom = bottomOf(el);
    }
    setPan(inset && bottom > visible ? Math.min(inset, Math.ceil(bottom - (visible - 12))) : 0);
  };
  window.__pocketKbInset = (px) => {
    if (inset !== px) {
      inset = px;
      if (vv) vv.dispatchEvent(new Event('resize'));
    }
    // Two frames later, once the page has reacted to the resize; also when hopping fields.
    if (px) requestAnimationFrame(() => requestAnimationFrame(window.__pocketKbReveal));
    else setPan(0);
  };
})();`;

// Dev server down or restarting: show a waiting screen and reconnect.
const UNREACHABLE = new Set([-100, -101, -102, -104, -105, -106, -109, -118, -324]);
const TITLE_BAR = 28;

function toUrl(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return `http://localhost:${raw}`;
  if (raw.startsWith(':')) return `http://localhost${raw}`;
  if (raw.startsWith('/')) return DEFAULT_URL + raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

function targetFrom(argv) {
  const flag = argv.find((a) => a.startsWith('--pocket-target='));
  return flag ? toUrl(flag.slice('--pocket-target='.length)) : null;
}

// ---- remembered between launches ----

let state = {};
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    state = {};
  }
}

function saveState(patch) {
  Object.assign(state, patch);
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    // Not worth interrupting anyone over.
  }
}

function savedPosition() {
  const { x, y } = state;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return {};
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height);
  return onScreen ? { x, y } : {};
}

// ---- the phone ----

let win;
let deviceId;
let mode;
let network;
let cpu;
let landscape;
let persona;
let keyboardChoice;
let keyboard = { visible: false };
let kbView = null;
let page = null; // the phone's web contents
let pageView = null;
let scale = 1;
let waitingFor = null;
let retryTimer = null;
let inflight = new Set(); // the page's requests still on their way, so agents know when it has settled

const device = () => DEVICES[deviceId];
const dims = () => {
  const d = device();
  return landscape ? { w: d.height, h: d.width } : { w: d.width, h: d.height };
};

// Shrink the phone (never its CSS viewport) if it would not fit on screen.
function fitScale(display) {
  const { w, h } = dims();
  const a = display.workAreaSize;
  return Math.min(1, (a.height - TITLE_BAR - 16) / h, (a.width - 16) / w);
}

const displayOf = (bounds) =>
  bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();

const contentSize = () => {
  const { w, h } = dims();
  return [Math.round(w * scale), Math.round(h * scale)];
};

// Who the page thinks it's talking to: the device's own browser, or an app's WebView.
function identity() {
  const d = device();
  const m = MODES[mode];
  if (mode === 'browser') return { userAgent: d.ua, platform: d.platform, ...(d.uaMeta ? { userAgentMetadata: d.uaMeta } : {}) };
  if (d.os === 'android') {
    return { userAgent: androidWebview(d.hw) + m.android(d), platform: d.platform, userAgentMetadata: androidMeta('Android WebView', d.hw.model) };
  }
  return { userAgent: (d.os === 'ipados' ? IPAD_WEBVIEW : IOS_WEBVIEW) + m.ios(d), platform: d.platform };
}

async function emulate() {
  const d = device();
  const { w, h } = dims();
  const p = PERSONAS[persona];
  const n = NETWORKS[network];
  const dbg = page.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  // One failed override should never stop the page from loading.
  const send = (method, params = {}) =>
    dbg.sendCommand(method, params).catch((err) => console.error(`${method}: ${err.message}`));
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    // A squeezing keyboard really does take the height away from the page.
    height: h - (keyboard.visible && keyboard.squeeze ? keyboard.height : 0),
    deviceScaleFactor: d.dpr,
    mobile: true,
    scale,
    screenWidth: w,
    screenHeight: h,
    screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  // A phone's page always has focus, even while you're in another app on the Mac.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setUserAgentOverride', { ...identity(), ...(p ? { acceptLanguage: p.languages } : {}) });
  await send('Emulation.setScrollbarsHidden', { hidden: true });
  // Where they are. Overrides refuse to stack, so clear before setting.
  await send('Emulation.setLocaleOverride');
  await send('Emulation.setTimezoneOverride', { timezoneId: '' });
  if (p) {
    await send('Emulation.setLocaleOverride', { locale: p.locale });
    await send('Emulation.setTimezoneOverride', { timezoneId: p.timezone });
    await send('Emulation.setGeolocationOverride', { latitude: p.geo[0], longitude: p.geo[1], accuracy: 30 });
  } else {
    await send('Emulation.clearGeolocationOverride');
  }
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: Boolean(n.offline),
    latency: n.latency || 0,
    downloadThroughput: n.down ? (n.down * 1000) / 8 : -1,
    uploadThroughput: n.up ? (n.up * 1000) / 8 : -1,
  });
  await send('Emulation.setCPUThrottlingRate', { rate: cpu });
}

// "/map" on the default server, "localhost:5173/map" elsewhere, nothing for about:blank.
function shortUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    const pathPart = u.pathname === '/' ? '' : u.pathname;
    return u.host === new URL(DEFAULT_URL).host && pathPart ? pathPart : u.host + pathPart;
  } catch {
    return '';
  }
}

// Everything that's not the default, in a few words. The window title and the panel share it.
function conditions() {
  const d = device();
  const { w, h } = dims();
  return [
    persona && PERSONAS[persona].city,
    `${d.label} ${w}×${h}`,
    mode !== 'browser' && MODES[mode].label,
    network !== 'none' && NETWORKS[network].label,
    cpu !== 1 && PHONE_SPEEDS[cpu].short,
  ].filter(Boolean);
}

let flashTimer = null;

function updateTitle() {
  if (flashTimer || !win || win.isDestroyed()) return;
  const parts = conditions();
  if (activity.errors) parts.unshift(`${activity.errors} error${activity.errors === 1 ? '' : 's'}`);
  parts.push(shortUrl(waitingFor || page.getURL()), waitingFor && (network === 'offline' ? 'offline' : 'waiting'));
  win.setTitle(parts.filter(Boolean).join(' · '));
  panelCall('status', conditions().join(' · '));
}

function flash(message) {
  if (!win || win.isDestroyed()) return;
  clearTimeout(flashTimer);
  win.setTitle(message);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    updateTitle();
  }, 1400);
}

let waitGen = 0; // bumped whenever waiting starts or stops, so stale probes die quietly

function stopWaiting() {
  clearTimeout(retryTimer);
  retryTimer = null;
  waitingFor = null;
  waitGen++;
}

function open(url) {
  stopWaiting();
  return page.loadURL(url).catch(() => {}); // failures are handled in did-fail-load
}

// Offline on purpose: say so and wait for the network to come back. Otherwise the dev
// server is down: wait and reconnect on our own.
function showWaiting(url) {
  const fresh = !waitingFor;
  waitingFor = url;
  page.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(waitingPage(url))}`).catch(() => {});
  updateTitle();
  if (!fresh || network === 'offline') return;
  const gen = ++waitGen;
  const probe = async () => {
    if (gen !== waitGen) return;
    try {
      await net.fetch(new URL(waitingFor).origin, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    } catch {
      if (gen === waitGen) retryTimer = setTimeout(probe, 1000);
      return;
    }
    if (gen === waitGen) open(waitingFor);
  };
  retryTimer = setTimeout(probe, 1000);
}

function reload() {
  if (waitingFor) open(waitingFor);
  else page.reload();
}

// Signed out, nothing stored: how a first-time visitor (say, from an ad) arrives.
// Only touches the current mode's cookie jar.
async function clearSiteData() {
  const s = page.session;
  await s.clearStorageData();
  await s.clearCache();
  if (waitingFor) open(waitingFor);
  else page.reloadIgnoringCache();
}

// The phone as it looks right now, keyboard included, as a PNG `width` pixels wide: the
// device's full resolution (e.g. 1179×2556 for an iPhone) unless asked for less.
async function capture(width) {
  let png;
  try {
    const shot = page.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
    const { data } = await Promise.race([shot, new Promise((_, no) => setTimeout(no, 8000))]);
    png = Buffer.from(data, 'base64');
  } catch {
    png = (await page.capturePage()).toPNG();
  }
  // With the keyboard up, the screenshot shows it too: what you see is what you get.
  if (keyboard.visible && kbView) {
    const keys = (await kbView.webContents.capturePage()).toPNG();
    const url = (buf) => JSON.stringify(`data:image/png;base64,${buf.toString('base64')}`);
    const merged = await kbView.webContents
      .executeJavaScript(`window.kb.compose(${url(png)}, ${url(keys)}, ${keyboard.height / dims().w}, ${Boolean(keyboard.squeeze)}, ${(keyboard.pan || 0) / dims().w}, ${width || 0})`)
      .catch(() => null);
    if (merged) return Buffer.from(merged, 'base64');
  }
  return width ? nativeImage.createFromBuffer(png).resize({ width, quality: 'best' }).toPNG() : png;
}

async function copyScreenshot() {
  const png = await capture();
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  flash('Screenshot copied');
}

// ---- the on-screen keyboard ----

const keyboardStyle = () => {
  if (keyboardChoice !== 'auto') return keyboardChoice;
  const d = device();
  if (d.os !== 'android') return 'apple';
  return d.hw.maker === 'samsung' ? 'samsung' : 'gboard';
};

// About the height of the real thing, in the page's own pixels.
function keyboardHeight(style, kind) {
  const { w, h } = dims();
  const tablet = device().os === 'ipados';
  const pad = kind === 'numeric' || kind === 'phone';
  let px;
  if (landscape) px = h * (tablet ? 0.5 : style === 'apple' ? 0.6 : 0.56);
  else if (style === 'apple') {
    const homeButton = h < 700; // iPhone SE: no home-indicator strip under the keys
    if (tablet) px = 345;
    else if (pad) px = homeButton ? 260 : 294;
    else px = homeButton ? 304 : 260 + w * 0.3;
  } else px = w * (style === 'samsung' ? 0.89 : 0.82);
  return Math.round(Math.min(px, h * 0.6));
}

// Safari and Chrome cover the bottom of the page and shrink only what's visible; Android
// in-app browsers (and pages that ask with interactive-widget=resizes-content) squeeze the
// whole page instead.
const keyboardSqueezes = (asked) => device().os === 'android' && (mode !== 'browser' || asked);

const pageRun = (code) => page.executeJavaScript(code).catch(() => {});
const refreshKeyboard = () => pageRun('window.__pocketKbRefresh && window.__pocketKbRefresh()');

// The page view fills the window, nudged up while the phone pans a covered field into view.
function layoutPage() {
  if (!pageView) return;
  const [cw, ch] = win.getContentSize();
  const pan = keyboard.visible ? Math.round((keyboard.pan || 0) * scale) : 0;
  pageView.setBounds({ x: 0, y: -pan, width: cw, height: ch });
}

// The page asks for a pan when scrolling alone can't lift the field above the keyboard
// (a bar fixed to the bottom, or the very end of the page), as Safari and Chrome do.
function setPan(px) {
  if (!keyboard.visible) return;
  keyboard.pan = Math.max(0, Math.min(px, keyboard.height));
  layoutPage();
}

async function layoutKeyboard() {
  if (!kbView) return;
  if (!keyboard.visible) {
    kbView.setVisible(false);
    return;
  }
  const { w, h } = dims();
  const [cw, ch] = win.getContentSize();
  const kh = Math.round(keyboard.height * scale);
  kbView.setBounds({ x: 0, y: ch - kh, width: cw, height: kh });
  kbView.webContents.setZoomFactor(scale);
  const homeIndicator = keyboard.style === 'apple' && device().os === 'ios' && !landscape && h >= 700;
  const options = { style: keyboard.style, kind: keyboard.kind, enter: keyboard.enter, width: w, height: keyboard.height, landscape, homeIndicator };
  await kbView.webContents.executeJavaScript(`window.kb && window.kb.render(${JSON.stringify(options)})`).catch(() => {});
  if (keyboard.visible) kbView.setVisible(true);
}

// Called by the page (through the hook) whenever focus moves; null hides the keyboard.
// One change at a time, so quick hops between fields can't interleave.
let keyboardQueue = Promise.resolve();
function setKeyboard(report) {
  keyboardQueue = keyboardQueue.then(() => applyKeyboard(report)).catch(() => {});
  return keyboardQueue;
}

async function applyKeyboard(report) {
  const style = keyboardStyle();
  const wasSqueezing = keyboard.visible && keyboard.squeeze;
  const pan = keyboard.visible ? keyboard.pan || 0 : 0; // hopping between fields keeps the pan until the page says otherwise
  keyboard = report && report.show && style !== 'off'
    ? { visible: true, style, kind: report.kind, enter: report.enter, height: keyboardHeight(style, report.kind), squeeze: keyboardSqueezes(report.squeezeAsked), pan }
    : { visible: false };
  if (!keyboard.visible) layoutPage();
  await layoutKeyboard();
  if (wasSqueezing || keyboard.squeeze) await emulate();
  await pageRun(`window.__pocketKbInset && window.__pocketKbInset(${keyboard.visible && !keyboard.squeeze ? keyboard.height : 0})`);
  if (keyboard.squeeze) setTimeout(() => pageRun('window.__pocketKbReveal && window.__pocketKbReveal()'), 60);
}

// ---- activity: Mixpanel events, page errors and failed requests ----

const activity = { rows: [], events: 0, errors: 0 };
let rowSeq = 0; // every row gets the next number, so an agent can ask for what's new since its last look
// Dev-server chatter that isn't a real failure.
const NOISE = /hot-update|webpack-hmr|__nextjs|_next\/static\/development|favicon\.ico/;
const MIXPANEL_DEFAULTS = new Set(['token', 'distinct_id', 'time', 'mp_lib', 'mp_sent_by_lib_version']);

function record(row) {
  row.id = ++rowSeq;
  row.time = Date.now();
  activity.rows.unshift(row);
  activity.rows.length = Math.min(activity.rows.length, 400);
  if (row.kind === 'event') activity.events++;
  if (row.kind === 'error' || row.kind === 'request') activity.errors++;
  panelCall('add', row);
  showCounts();
}

function showCounts() {
  if (app.dock) app.dock.setBadge(activity.errors ? String(activity.errors) : '');
  panelCall('counts', { events: activity.events, errors: activity.errors });
  updateTitle();
}

// A new page starts a clean slate for the counts; the panel keeps the history.
function pageChanged(url) {
  const where = shortUrl(url);
  if (!where) return;
  activity.events = 0;
  activity.errors = 0;
  const row = { id: ++rowSeq, kind: 'nav', where, time: Date.now() };
  activity.rows.unshift(row);
  panelCall('add', row);
  showCounts();
}

function clearActivity() {
  activity.rows = [];
  activity.events = 0;
  activity.errors = 0;
  panelCall('reset', { rows: [], status: conditions().join(' · '), counts: activity });
  showCounts();
}

const brief = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};

// Mixpanel's /track calls, wherever they're sent (straight to Mixpanel or through your own
// proxy): a `data` field holding one event or a batch, as JSON or base64'd JSON.
function mixpanelEvents(url, body) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (!/\/track\/?$/.test(u.pathname)) return [];
  const raw = (body && new URLSearchParams(body).get('data')) || u.searchParams.get('data') || body;
  if (!raw) return [];
  for (const text of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
    try {
      const parsed = JSON.parse(text);
      return (Array.isArray(parsed) ? parsed : [parsed]).filter((e) => e && typeof e.event === 'string');
    } catch {
      // try the next encoding
    }
  }
  return [];
}

function recordEvents(url, body) {
  for (const e of mixpanelEvents(url, body)) {
    const props = e.properties || {};
    const own = Object.entries(props)
      .filter(([k]) => !k.startsWith('$') && !k.startsWith('mp_') && !MIXPANEL_DEFAULTS.has(k));
    record({
      kind: 'event',
      title: e.event,
      detail: props.$current_url ? shortUrl(props.$current_url) : '',
      props: own.slice(0, 12).map(([k, v]) => [k, brief(v)]), // what the panel shows
      data: Object.fromEntries(own), // all of it, for agents checking properties
    });
  }
}

function watchActivity(view) {
  const wc = view.webContents;
  const current = () => view === pageView;
  const requests = new Map();
  wc.on('console-message', (details) => {
    if (!current() || details.level !== 'error') return;
    const source = details.sourceId ? `${shortUrl(details.sourceId) || details.sourceId}:${details.lineNumber}` : '';
    record({ kind: 'error', title: details.message.split('\n')[0].slice(0, 300), detail: source });
  });
  wc.debugger.on('message', async (_e, method, params) => {
    if (!current()) return;
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request, type } = params;
      requests.set(requestId, { method: request.method, url: request.url, type });
      if (requests.size > 2000) requests.delete(requests.keys().next().value);
      if (type !== 'EventSource' && !request.url.startsWith('data:')) inflight.add(requestId);
      if (/\/track\/?(\?|$)/.test(request.url.split('#')[0])) {
        let body = request.postData;
        if (!body && request.hasPostData) {
          body = await wc.debugger.sendCommand('Network.getRequestPostData', { requestId }).then((r) => r.postData).catch(() => '');
        }
        recordEvents(request.url, body);
      }
    } else if (method === 'Network.responseReceived') {
      const { status, url } = params.response;
      if (params.response.mimeType === 'text/event-stream') inflight.delete(params.requestId); // a stream stays open on purpose
      if (status >= 400 && !NOISE.test(url) && /^https?:/.test(url)) {
        const r = requests.get(params.requestId) || { method: 'GET' };
        record({ kind: 'request', title: `${status} ${r.method} ${shortUrl(url) || url}`, detail: params.response.statusText || '' });
      }
    } else if (method === 'Network.loadingFinished') {
      inflight.delete(params.requestId);
    } else if (method === 'Network.loadingFailed') {
      inflight.delete(params.requestId);
      const r = requests.get(params.requestId);
      // Cancelled requests are normal; a failed page load already shows its own screen.
      if (!r || params.canceled || params.type === 'Document' || NOISE.test(r.url) || !/^https?:/.test(r.url)) return;
      const why = params.corsErrorStatus ? `Blocked by CORS (${params.corsErrorStatus.corsError})` : params.errorText;
      record({ kind: 'request', title: `Failed ${r.method} ${shortUrl(r.url) || r.url}`, detail: why });
    }
  });
}

// ---- the activity panel: docked beside the phone, moving with it ----

let panel = null;
const PANEL_WIDTH = 320;

function placePanel() {
  if (!panel) return;
  const b = win.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const right = b.x + b.width + 10;
  const x = right + PANEL_WIDTH <= a.x + a.width ? right : Math.max(a.x, b.x - PANEL_WIDTH - 10);
  panel.setBounds({ x, y: b.y, width: PANEL_WIDTH, height: b.height });
}

function panelCall(fn, arg) {
  if (!panel || panel.webContents.isLoading()) return;
  panel.webContents.executeJavaScript(`window.pocket.${fn}(${JSON.stringify(arg)})`).catch(() => {});
}

function togglePanel() {
  if (panel) {
    panel.close();
    return;
  }
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 600,
    parent: win,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#141412',
    webPreferences: { partition: 'pocket-panel' },
  });
  placePanel();
  panel.on('closed', () => {
    panel = null;
    syncMenus();
  });
  panel.webContents.on('console-message', (details) => {
    if (details.message === 'pocket:clear') clearActivity();
  });
  panel.webContents.once('did-finish-load', () => {
    panelCall('reset', { rows: activity.rows, status: conditions().join(' · '), counts: activity });
    panel.showInactive();
  });
  panel.loadFile(path.join(__dirname, 'panel.html')).catch(() => {});
  syncMenus();
}

// ---- changing things ----

// Ticks live in several menus (and separators would split native radio groups), so they're
// kept in step by hand.
function syncMenus() {
  const menu = Menu.getApplicationMenu();
  const tick = (id, on) => {
    const item = menu && menu.getMenuItemById(id);
    if (item) item.checked = on;
  };
  for (const id of Object.keys(DEVICES)) tick(`device-${id}`, id === deviceId);
  for (const id of MODE_ORDER) tick(`mode-${id}`, id === mode);
  for (const id of NETWORK_ORDER) tick(`net-${id}`, id === network);
  for (const rate of Object.keys(PHONE_SPEEDS)) tick(`cpu-${rate}`, Number(rate) === cpu);
  for (const id of Object.keys(PERSONAS)) tick(`persona-${id}`, id === persona);
  tick('persona-none', !persona);
  for (const id of KEYBOARD_ORDER) tick(`kb-${id}`, id === keyboardChoice);
  tick('landscape', landscape);
  tick('panel', Boolean(panel));
}

// A bigger device can push the window past the edge of the screen: slide it back in.
function keepOnScreen() {
  const b = win.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  const x = Math.max(a.x, Math.min(b.x, a.x + a.width - b.width));
  const y = Math.max(a.y, Math.min(b.y, a.y + a.height - b.height));
  if (x !== b.x || y !== b.y) {
    win.setPosition(x, y);
    saveState({ x, y });
  }
}

function resize() {
  scale = fitScale(displayOf(win.getBounds()));
  win.setContentSize(...contentSize());
  keepOnScreen();
  placePanel();
  layoutPage();
  layoutKeyboard();
}

// A different cookie jar means a different page underneath: swap it in, same window.
async function swapPage() {
  const url = waitingFor || page.getURL();
  stopWaiting();
  await createPage();
  open(/^https?:/i.test(url) ? url : target || DEFAULT_URL);
}

// Every change to the phone and its situation goes through here, from the menus and from
// agents alike, doing as little as possible: another app needs a fresh page (its own cookie
// jar), another phone or person needs a reload, and the rest (network, phone speed,
// keyboard, turning the phone) applies to the page as it is, just as on a real phone.
// A persona sets everything at once; "Just Me" (persona: null) goes back to your own place
// and normal conditions, keeping whatever phone you're on.
async function applyScene(next = {}) {
  const was = { deviceId, mode, persona, network, cpu, landscape, keyboardChoice };
  if ('persona' in next) {
    const p = PERSONAS[next.persona];
    persona = p ? next.persona : null;
    if (p) deviceId = p.device;
    mode = p ? p.mode : 'browser';
    network = p ? p.network : 'none';
    cpu = p ? p.cpu : 1;
  }
  if (DEVICES[next.device]) deviceId = next.device;
  if (MODES[next.mode]) mode = next.mode;
  if (NETWORKS[next.network]) network = next.network;
  if (PHONE_SPEEDS[next.cpu]) cpu = Number(next.cpu);
  if (typeof next.landscape === 'boolean') landscape = next.landscape;
  if (KEYBOARDS[next.keyboard]) keyboardChoice = next.keyboard;
  saveState({ device: deviceId, mode, persona, network, cpu, landscape, keyboard: keyboardChoice });
  syncMenus();

  const newApp = mode !== was.mode;
  const reloads = !newApp && (deviceId !== was.deviceId || persona !== was.persona);
  if (keyboard.visible && (newApp || reloads)) await setKeyboard(null); // the field goes with the page
  if (deviceId !== was.deviceId || landscape !== was.landscape) resize();
  if (newApp) await swapPage();
  else {
    await emulate();
    if (reloads) reload();
    else if (was.network === 'offline' && network !== 'offline' && waitingFor) open(waitingFor);
  }
  updateTitle();
  // A sideways keyboard is a lot shorter, and a different one may be wanted: show it afresh.
  if (!newApp && !reloads && (keyboardChoice !== was.keyboardChoice || landscape !== was.landscape)) refreshKeyboard();
}

function setFloat(on) {
  win.setAlwaysOnTop(on, 'floating');
  saveState({ float: on });
}

function toggleDevTools() {
  const wc = page;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const history = () => page.navigationHistory;
  // A menu pick can still be finishing when Pocket quits: say so rather than throw.
  const change = (next) => applyScene(next).catch((err) => console.error(`Changing the scene: ${err.message}`));
  const pick = (id, label, checked, click, accelerator) =>
    ({ id, label, type: 'checkbox', checked, click, ...(accelerator ? { accelerator } : {}) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: reload },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => page.reloadIgnoringCache() },
        { label: 'Clear Cookies and Storage', accelerator: 'CmdOrCtrl+Shift+Backspace', click: clearSiteData },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => history().canGoBack() && history().goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => history().canGoForward() && history().goForward() },
        { type: 'separator' },
        pick('panel', 'Activity Panel', Boolean(panel), togglePanel, 'CmdOrCtrl+E'),
        { label: 'Copy Screenshot', accelerator: 'CmdOrCtrl+Shift+C', click: copyScreenshot },
        { type: 'separator' },
        pick('float', 'Float on Top', state.float !== false, (item) => setFloat(item.checked), 'CmdOrCtrl+Shift+F'),
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: toggleDevTools },
      ],
    },
    {
      label: 'Persona',
      submenu: [
        ...Object.entries(PERSONAS).map(([id, p]) => pick(`persona-${id}`, p.label, id === persona, () => change({ persona: id }))),
        { type: 'separator' },
        pick('persona-none', 'Just Me (your own location, normal conditions)', !persona, () => change({ persona: null })),
      ],
    },
    {
      label: 'Device',
      submenu: [
        ...DEVICE_GROUPS.flatMap((group, g) => [
          ...(g ? [{ type: 'separator' }] : []),
          ...group.map((id) => pick(
            `device-${id}`,
            `${DEVICES[id].label}  ${DEVICES[id].width}×${DEVICES[id].height}`,
            id === deviceId,
            () => change({ device: id }),
            `CmdOrCtrl+${DEVICE_GROUPS.flat().indexOf(id) + 1}`,
          )),
        ]),
        { type: 'separator' },
        pick('landscape', 'Landscape', landscape, (item) => change({ landscape: item.checked }), 'CmdOrCtrl+L'),
      ],
    },
    {
      label: 'Keyboard',
      submenu: KEYBOARD_ORDER.flatMap((id) => [
        ...(id === 'apple' || id === 'off' ? [{ type: 'separator' }] : []),
        pick(`kb-${id}`, KEYBOARDS[id], id === keyboardChoice, () => change({ keyboard: id })),
      ]),
    },
    {
      label: 'Open In',
      submenu: MODE_ORDER.map((id, i) => pick(
        `mode-${id}`,
        id === 'browser' ? 'Browser (Safari or Chrome)' : `${MODES[id].label} In-App Browser`,
        id === mode,
        () => change({ mode: id }),
        `Alt+CmdOrCtrl+${i + 1}`,
      )),
    },
    {
      label: 'Speed',
      submenu: [
        { label: 'Network', enabled: false },
        ...NETWORK_ORDER.map((id) => pick(
          `net-${id}`,
          NETWORKS[id].detail ? `${NETWORKS[id].label}  ${NETWORKS[id].detail}` : NETWORKS[id].label,
          id === network,
          () => change({ network: id }),
        )),
        { type: 'separator' },
        { label: 'Phone', enabled: false },
        ...Object.entries(PHONE_SPEEDS).map(([rate, s]) => pick(
          `cpu-${rate}`,
          s.detail ? `${s.label}  ${s.detail}` : s.label,
          Number(rate) === cpu,
          () => change({ cpu: Number(rate) }),
        )),
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// The window is a frame holding two layers: the page, and the keyboard above it. The page
// is its own view so it can be swapped (another app's cookie jar) without touching the
// window, and nudged up when a phone would pan the page above the keyboard.
async function createWindow(position) {
  scale = fitScale(displayOf(position.x === undefined ? null : { ...position, width: 1, height: 1 }));
  const [width, height] = contentSize();
  const w = new BrowserWindow({
    width,
    height,
    ...position,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: state.float !== false,
    backgroundColor: '#0b0b0c',
    webPreferences: { partition: 'pocket-frame' },
  });
  win = w;
  if (state.float !== false) w.setAlwaysOnTop(true, 'floating');
  keepOnScreen();
  w.on('page-title-updated', (e) => e.preventDefault());
  w.on('moved', () => {
    const [x, y] = w.getPosition();
    saveState({ x, y });
  });
  w.on('focus', () => page && page.focus()); // typing goes to the phone, not the empty frame

  // The on-screen keyboard, shown while a text field has focus.
  const kb = new WebContentsView({ webPreferences: { partition: 'pocket-keyboard' } });
  kb.setBackgroundColor('#00000000');
  kb.setVisible(false);
  w.contentView.addChildView(kb);
  kb.webContents.loadFile(path.join(__dirname, 'keyboard.html')).catch(() => {});
  kbView = kb;
  // Clicking the keys doesn't take focus from the field, like a real keyboard; Done and
  // Gboard's hide arrow put it away.
  kb.webContents.on('focus', () => page && page.focus());
  kb.webContents.on('console-message', (details) => {
    if (details.message === 'pocket:keyboard-done') pageRun('document.activeElement && document.activeElement.blur()');
  });

  await createPage();
}

// A fresh page view in the current mode's cookie jar. Replaces the old one once it's ready.
async function createPage() {
  const old = pageView;
  // Kept at full speed behind other windows too: a phone in your hand is never in the background.
  const view = new WebContentsView({ webPreferences: { partition: partitionFor(mode), backgroundThrottling: false } });
  view.setBackgroundColor('#ffffff'); // what a phone browser shows behind a page that sets no background
  win.contentView.addChildView(view, 0); // under the keyboard
  const [cw, ch] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width: cw, height: ch });
  pageView = view;
  page = view.webContents;
  keyboard = { visible: false };
  inflight = new Set();
  layoutKeyboard();

  // Everything below belongs to this page only; a page being swapped out stays quiet.
  const current = () => view === pageView;
  const wc = view.webContents;
  wc.on('did-navigate', (_e, url) => {
    if (!current()) return;
    if (keyboard.visible) setKeyboard(null);
    pageChanged(url);
    updateTitle();
  });
  wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => current() && isMainFrame && updateTitle());
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (current() && isMainFrame && UNREACHABLE.has(code) && !url.startsWith('data:')) showWaiting(url);
  });
  wc.debugger.on('detach', (_e, reason) => {
    if (current() && reason !== 'target closed') setTimeout(() => emulate().then(() => hookPage(wc)).catch(() => {}), 100);
  });
  // Opening or closing DevTools resets parts of the emulation (e.g. navigator.platform).
  wc.on('devtools-opened', () => current() && emulate().catch(() => {}));
  wc.on('devtools-closed', () => current() && emulate().catch(() => {}));
  wc.setWindowOpenHandler(({ url }) => {
    const web = /^https?:/i.test(url);
    let sameHost = false;
    try {
      sameHost = new URL(url).host === new URL(wc.getURL()).host;
    } catch {
      // not a URL we can compare
    }
    // In-app browsers keep every link inside. In browser mode a new tab means: same
    // site stays here, anything else opens in your real browser.
    if (web && (mode !== 'browser' || sameHost)) wc.loadURL(url).catch(() => {});
    else if (web) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (_e, input) => {
    if (current() && keyboard.visible && input.type === 'keyDown') {
      kbView.webContents.executeJavaScript(`window.kb && window.kb.press(${JSON.stringify(input.key)})`).catch(() => {});
    }
  });
  wc.debugger.on('message', (_e, method, params) => {
    if (!current() || method !== 'Runtime.bindingCalled' || params.name !== '__pocketKeyboard') return;
    try {
      const report = JSON.parse(params.payload);
      if ('pan' in report) setPan(report.pan);
      else setKeyboard(report);
    } catch {
      // not a message we understand
    }
  });
  watchActivity(view);

  // Emulation needs a live page first: overriding before any navigation crashes Electron.
  await wc.loadURL('about:blank');
  await emulate();
  await hookPage(wc);
  if (old) {
    win.contentView.removeChildView(old);
    old.webContents.close();
  }
  wc.focus();
}

// Lets every page Pocket opens tell it when the keyboard should come up.
async function hookPage(wc) {
  const steps = [
    ['Runtime.enable'],
    ['Page.enable'],
    ['Runtime.addBinding', { name: '__pocketKeyboard' }],
    ['Page.addScriptToEvaluateOnNewDocument', { source: KEYBOARD_HOOK }],
  ];
  for (const [method, params = {}] of steps) {
    await wc.debugger.sendCommand(method, params).catch((err) => console.error(`${method}: ${err.message}`));
  }
}

// ---- for agents ----
// What agents (Claude, Cursor, by way of mcp.js and agent.js) can see and do. It's the same
// phone in the same window, so whatever they do plays out where you can watch it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The scene in plain words, next to the names agents use to change it.
function sceneInfo() {
  const d = device();
  const { w, h } = dims();
  const n = NETWORKS[network];
  const s = PHONE_SPEEDS[cpu];
  const p = PERSONAS[persona];
  return {
    device: deviceId,
    phone: `${d.label} ${w}×${h}`,
    landscape,
    app: mode,
    browser: mode === 'browser' ? (d.os === 'android' ? 'Chrome' : 'Safari') : `${MODES[mode].label}'s in-app browser`,
    persona: persona || 'none',
    who: p ? p.label : 'Just you: your own language, clock and location',
    network,
    networkLabel: n.detail ? `${n.label} (${n.detail})` : n.label,
    cpu,
    phoneSpeed: s.detail ? `${s.label} (${s.detail})` : s.label,
    keyboard: keyboardChoice,
    keyboardLabel: keyboardChoice === 'auto' ? `${KEYBOARDS.auto}, so ${KEYBOARDS[keyboardStyle()]}` : KEYBOARDS[keyboardChoice],
    url: waitingFor || page.getURL(),
    title: waitingFor ? '' : page.getTitle(),
    waiting: Boolean(waitingFor),
    w,
    h,
    dpr: d.dpr,
  };
}

// For agents, "/map" means that path on whatever site is open now.
function resolveUrl(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('/')) {
    try {
      const here = new URL(waitingFor || page.getURL());
      if (/^https?:$/.test(here.protocol)) return here.origin + s;
    } catch {
      // nothing open yet: the default server
    }
  }
  return toUrl(s);
}

// Waits until the page has stopped loading and its requests have gone quiet (for up to `ms`),
// and the keyboard has caught up. False if something was still going when time ran out.
async function settle(ms = 4000) {
  const t0 = Date.now();
  await sleep(120);
  let quietSince = 0;
  while (Date.now() - t0 < ms) {
    if (page.isLoading() || inflight.size) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= 300) break;
    await sleep(50);
  }
  await keyboardQueue;
  await sleep(80); // the pan follows the keyboard a couple of frames later
  return !(page.isLoading() || inflight.size);
}

const forAgents = {
  sceneInfo,
  applyScene,
  options: { devices: Object.keys(DEVICES), apps: MODE_ORDER, personas: Object.keys(PERSONAS), networks: NETWORK_ORDER, keyboards: KEYBOARD_ORDER },
  page: () => page,
  keyboard: () => ({ ...keyboard }),
  capture,
  open: (raw) => open(resolveUrl(raw)),
  reload,
  settle,
  inflight: () => inflight.size,
  activity: (after) => activity.rows.filter((r) => r.id > after).reverse(),
  lastActivityId: () => rowSeq,
  counts: () => ({ events: activity.events, errors: activity.errors }),
  flash,
  lightKey: (k) => kbView && kbView.webContents.executeJavaScript(`window.kb && window.kb.press(${JSON.stringify(k)})`).catch(() => {}),
  dismissKeyboard: () => pageRun('document.activeElement && document.activeElement.blur()'),
};

let agents = null;

async function start(firstUrl) {
  app.setAboutPanelOptions({
    applicationName: 'Pocket',
    applicationVersion: app.getVersion(),
    credits: 'Your localhost, pocket-sized.',
  });
  // The built Pocket.app carries its icon; this covers running from source.
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  loadState();
  deviceId = DEVICES[state.device] ? state.device : 'iphone';
  mode = MODES[state.mode] ? state.mode : 'browser';
  network = NETWORKS[state.network] ? state.network : 'none';
  cpu = PHONE_SPEEDS[state.cpu] ? Number(state.cpu) : 1;
  landscape = state.landscape === true;
  persona = PERSONAS[state.persona] ? state.persona : null;
  keyboardChoice = KEYBOARDS[state.keyboard] ? state.keyboard : 'auto';
  buildMenu();
  await createWindow(savedPosition());
  agents = serveAgents(path.join(app.getPath('userData'), 'agent.sock'), forAgents);
  open(firstUrl || DEFAULT_URL);
}

function waitingPage(url) {
  const safe = (shortUrl(url) || url).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const offline = network === 'offline';
  const heading = offline ? 'Offline' : `Waiting for ${safe}`;
  const hint = offline
    ? 'Pocket is pretending there’s no connection. Pick a network in Speed to come back.'
    : 'Start your dev server and this loads on its own.';
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${offline ? 'Offline' : 'Waiting'}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #0b0b0c; color: #e9e9ea;
         font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { text-align: center; padding: 24px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #e9e9ea; margin: 0 auto 20px;
         animation: pulse 1.4s ease-in-out infinite; }
  .where { font-weight: 600; font-size: 17px; }
  .hint { margin-top: 6px; color: #8e8e93; font-size: 13px; }
  @keyframes pulse { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
</style>
<main>
  <div class="dot"></div>
  <div class="where">${heading}</div>
  <div class="hint">${hint}</div>
</main>`;
}

// ---- boot ----

const target = targetFrom(process.argv);

if (!app.requestSingleInstanceLock({ target })) {
  app.quit();
} else {
  // `pocket` again focuses this window; `pocket 5173` also points it somewhere new.
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    if (!win) return;
    if (data && data.target) open(data.target);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => agents && agents.close());
  app.whenReady().then(() => start(target)).catch((err) => console.error(err));
}
