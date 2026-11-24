#!/usr/bin/env node
'use strict';
// Pocket's MCP server: gives the Claude app, Claude Code, Cursor or any other MCP client four
// tools that drive the Pocket phone on this Mac (scene, look, act, activity). Nothing needs
// installing, because Pocket's own binary runs it as plain Node. In the client's MCP config:
//
//   "pocket": {
//     "command": "/Applications/Pocket.app/Contents/MacOS/Pocket",
//     "args": ["/Applications/Pocket.app/Contents/Resources/app.asar/mcp.js"],
//     "env": { "ELECTRON_RUN_AS_NODE": "1" }
//   }
//
// It speaks MCP over stdin and stdout, and hands each call to the running Pocket over a private
// socket in Pocket's own folder, opening Pocket first if it isn't running. The tool list lives
// here, so a client can read it at startup without Pocket popping up.

const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

const SOCKET = process.env.POCKET_SOCKET || path.join(os.homedir(), 'Library', 'Application Support', 'Pocket', 'agent.sock');
const BUNDLE_ID = 'dev.tomduchambon.pocket';
const PROTOCOL = '2025-06-18';
let VERSION = '1.0.0';
try {
  VERSION = require('./package.json').version;
} catch {
  // run from somewhere unusual: the default will do
}

const INSTRUCTIONS = `Pocket is the user's phone emulator for their localhost: a real Chromium page with a phone's size, touch, user agent and on-screen keyboard, in a window on their Mac. It's the same phone they're looking at, so everything you do plays out in front of them. A typical check: scene to pick the phone, act open (a URL, a port like 3000 or a path like /map), look, then act tap, type, press or scroll, look again, and activity to confirm which Mixpanel events fired and that nothing errored.`;

const TOOLS = [
  {
    name: 'scene',
    description: 'Read or change the phone and its situation. With no arguments it just reports the scene. A persona sets device, app, network and phone speed in one go, plus that person\'s language, clock and location; anything else you pass overrides it, and persona "none" goes back to normal conditions on the same phone. Changing the phone or the person reloads the page; changing the app reopens the page in that app\'s browser, with its own cookies; network, phone speed, keyboard and landscape apply without a reload.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          enum: ['iphone-se', 'iphone', 'iphone-pro', 'iphone-pro-max', 'android', 'pixel', 'ipad-mini'],
          description: 'iphone-se 375×667, iphone 393×852, iphone-pro 402×874, iphone-pro-max 440×956, android (a small Samsung) 360×800, pixel 412×915, ipad-mini 744×1133, all in points.',
        },
        app: {
          type: 'string',
          enum: ['browser', 'instagram', 'facebook'],
          description: 'browser is Safari on Apple devices and Chrome on Android; instagram and facebook are those apps\' in-app browsers, which is what people get when they tap a link or an ad there.',
        },
        persona: {
          type: 'string',
          enum: ['london', 'newyork', 'lagos', 'mumbai', 'none'],
          description: 'london: iPhone in Safari, fast 4G. newyork: iPhone Pro from an Instagram ad, fast 4G. lagos: small Android from an Instagram ad, slow 4G, budget phone. mumbai: small Android from a Facebook ad, 3G, budget phone. none: the user\'s own place and normal conditions.',
        },
        network: {
          type: 'string',
          enum: ['none', 'fast4g', 'slow4g', '3g', 'offline'],
          description: 'Chrome DevTools\' presets; none means no throttling.',
        },
        phone_speed: {
          type: 'string',
          enum: ['fast', 'mid-range', 'budget'],
          description: 'How fast the phone runs scripts: mid-range is 4× slower than the Mac, budget 6×.',
        },
        keyboard: {
          type: 'string',
          enum: ['auto', 'apple', 'samsung', 'gboard', 'off'],
          description: 'The on-screen keyboard that comes up when a field has focus; auto matches the phone.',
        },
        landscape: { type: 'boolean', description: 'Turn the phone sideways, without a reload.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set the scene', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'look',
    description: 'See the phone the way the user does: a screenshot (with the keyboard while it\'s up) and a list of what\'s on screen, top to bottom, with buttons, links and fields and their tap points, headings and text, plus whatever the keyboard hides. Screenshot pixels are page points, so an x,y read off it works as a tap target. wait_for waits up to 45 seconds for text that arrives slowly, such as an answer that streams in.',
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          enum: ['normal', 'sharp', 'none'],
          description: 'normal (the default): one pixel per point. sharp: the phone\'s full resolution, for judging visual detail. none: just the text, which is cheaper.',
        },
        wait_for: { type: 'string', description: 'Text to wait for, up to 45 seconds, before looking.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Look at the phone', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'act',
    description: 'Do what a person would do on the phone, then wait for the page to settle. Returns what happened, where things stand (page and keyboard) and anything the action fired: Mixpanel events, errors, failed requests. Actions: open (url), tap (target), type (text, plus a target to tap first, whose text it replaces), press (key), scroll (direction, optionally inside a target such as a list, a sheet or the map), back, reload. A target is a visible label or text ("Sign in"), a CSS selector ("#email") or an x,y point from the screenshot. Tapping scrolls the target into view if needed, and refuses when it\'s stuck under the keyboard, because a person couldn\'t reach it either.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'tap', 'type', 'press', 'scroll', 'back', 'reload'] },
        target: { type: 'string', description: 'For tap, type and scroll: a visible label or text, a CSS selector, or an x,y point from the screenshot.' },
        text: { type: 'string', description: 'For type. A newline presses Enter.' },
        key: {
          type: 'string',
          enum: ['Enter', 'Backspace', 'Tab', 'Escape', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Done'],
          description: 'For press. Done puts the keyboard away, like the button on the keyboard.',
        },
        url: { type: 'string', description: 'For open: a full address, a port (3000), or a path on the current site (/map).' },
        direction: {
          type: 'string',
          enum: ['down', 'up', 'left', 'right'],
          description: 'For scroll, down by default: down shows what\'s further down, as a finger swiping up would.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { title: 'Act on the phone', readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'activity',
    description: 'What the page did since your last check, oldest first: Mixpanel events with their properties, console errors, failed requests (4xx and 5xx responses, network and CORS failures) and page loads. Check once before a flow to start clean, then again after it to see exactly what the flow fired.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'What the page did', readOnlyHint: true, openWorldHint: false },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- talking to Pocket ----

let conn = null;
let nextId = 1;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET);
    let buffer = '';
    sock.setEncoding('utf8');
    sock.once('connect', () => {
      conn = sock;
      resolve(sock);
    });
    sock.on('error', (err) => {
      if (conn !== sock) reject(err);
    });
    sock.on('data', (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = pending.get(msg.id);
        if (p) p.resolve(msg);
      }
    });
    sock.on('close', () => {
      if (conn === sock) conn = null;
      for (const p of pending.values()) p.reject(new Error('Pocket closed before it answered (did it quit?).'));
      pending.clear();
    });
  });
}

async function ensureConnected() {
  if (conn && !conn.destroyed) return conn;
  try {
    return await connect();
  } catch {
    // not running yet
  }
  // Open Pocket in the background (your window comes up, your focus stays put) and wait for it.
  if (process.platform === 'darwin') execFile('open', ['-g', '-b', BUNDLE_ID], () => {});
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await sleep(400);
    try {
      return await connect();
    } catch {
      // still starting
    }
  }
  throw new Error('Pocket isn\'t running and didn\'t start. Open Pocket (or run `pocket` in a terminal), then try again.');
}

async function call(tool, args) {
  const sock = await ensureConnected();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Pocket took too long to answer.'));
    }, 100000);
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(msg);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    sock.write(`${JSON.stringify({ id, tool, args })}\n`);
  });
}

// Activity is "since your last check": remembered here, per client, and reset when Pocket restarts.
const seen = { lastId: 0, session: null };

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return { content: [{ type: 'text', text: `There's no tool called ${name}.` }], isError: true };
  try {
    const res = await call(name, name === 'activity' ? { after: seen.lastId, session: seen.session } : args);
    if (!res.ok) return { content: [{ type: 'text', text: res.error }], isError: true };
    if (name === 'activity') Object.assign(seen, { lastId: res.lastId, session: res.session });
    const content = [{ type: 'text', text: res.text }];
    if (res.image) content.push({ type: 'image', data: res.image, mimeType: 'image/png' });
    return { content };
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}

// ---- MCP over stdio: one JSON-RPC message per line ----

const write = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return; // notifications need no answer
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    write({
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pocket', title: 'Pocket', version: VERSION },
        instructions: INSTRUCTIONS,
      },
    });
  } else if (method === 'ping') {
    write({ id, result: {} });
  } else if (method === 'tools/list') {
    write({ id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    write({ id, result: await callTool(params.name, params.arguments || {}) });
  } else {
    write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`pocket mcp: not JSON: ${line.slice(0, 200)}\n`);
    return;
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) handle(m).catch((err) => process.stderr.write(`pocket mcp: ${err.stack}\n`));
});
lines.on('close', () => process.exit(0));
