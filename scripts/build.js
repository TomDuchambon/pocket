#!/usr/bin/env node
'use strict';
// `npm run build`: packages Pocket.app with its icon, signs it for this Mac
// (ad-hoc, no Apple account needed) and installs it into Applications.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUNDLE_ID = 'dev.tomduchambon.pocket';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// Node running under Rosetta reports x64 on Apple silicon; build for the real chip.
function macArch() {
  if (process.arch !== 'x64') return process.arch;
  try {
    return execFileSync('sysctl', ['-n', 'hw.optional.arm64']).toString().trim() === '1' ? 'arm64' : 'x64';
  } catch {
    return 'x64';
  }
}

function packagerOptions({ platform = 'darwin', arch = macArch() } = {}) {
  return {
    dir: ROOT,
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    platform,
    arch,
    name: 'Pocket',
    executableName: 'Pocket',
    appBundleId: BUNDLE_ID,
    appCategoryType: 'public.app-category.developer-tools',
    icon: path.join(ROOT, 'assets', 'icon.icns'),
    electronVersion: require('electron/package.json').version,
    asar: true,
    // The app is its own few files and package.json: no runtime dependencies to ship.
    ignore: [/^\/(assets|bin|dist|scripts|node_modules|\.git)(\/|$)/, /^\/(package-lock\.json|README\.md|\.gitignore)$/],
  };
}

const isOurs = (app) => {
  try {
    return fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(BUNDLE_ID);
  } catch {
    return false;
  }
};

// Where Pocket is installed, if it is.
function installedApp(home = os.homedir()) {
  return ['/Applications', path.join(home, 'Applications')]
    .map((dir) => path.join(dir, 'Pocket.app'))
    .find((app) => isOurs(app)) || null;
}

// /Applications if we can write there, else ~/Applications. Never touch another app called Pocket.
function installTarget() {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const app = path.join(dir, 'Pocket.app');
    if (fs.existsSync(app) && !isOurs(app)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return app;
    } catch {
      // not writable, try the next one
    }
  }
  throw new Error('There is already a different app called Pocket in both Applications folders.');
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('Pocket.app is built on a Mac. Elsewhere, run it with `npm start`.');
    process.exit(1);
  }
  const { packager } = await import('@electron/packager'); // ESM-only package

  try {
    // Quit a running Pocket so its files can be replaced. `is running` never launches it.
    execFileSync('osascript', ['-e',
      `if application id "${BUNDLE_ID}" is running then tell application id "${BUNDLE_ID}" to quit`], { stdio: 'ignore' });
  } catch {
    // not running, or never installed
  }

  const [outDir] = await packager(packagerOptions());
  const built = path.join(outDir, 'Pocket.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', built], { stdio: 'inherit' });

  const target = installTarget();
  fs.rmSync(target, { recursive: true, force: true });
  execFileSync('ditto', [built, target]);
  try {
    execFileSync(LSREGISTER, ['-f', target]); // so Spotlight and the Dock pick it up straight away
  } catch {
    // harmless if LaunchServices is slow to notice
  }
  console.log(`\nPocket is installed: ${target}\nOpen it from Spotlight, or type \`pocket\` in a terminal.`);
  console.log('To let Claude or Cursor drive it too: npm run connect');
}

// `npm run connect`: puts Pocket among the MCP servers of the Claude app and Cursor (whichever
// are on this Mac), pointing at the installed app, and leaves every other server and setting as
// it was. Agents run Pocket's MCP server with Pocket's own binary, so nothing else needs installing.
function connectAgents(target, home = os.homedir()) {
  const server = {
    command: path.join(target, 'Contents', 'MacOS', 'Pocket'),
    args: [path.join(target, 'Contents', 'Resources', 'app.asar', 'mcp.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  const clients = [
    ['Claude', path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
    ['Cursor', path.join(home, '.cursor', 'mcp.json')],
  ].filter(([, file]) => fs.existsSync(path.dirname(file))); // the ones on this Mac
  if (!clients.length) {
    console.log(`Found neither the Claude app nor Cursor here. Any MCP client can run Pocket with:\n"pocket": ${JSON.stringify(server, null, 2)}`);
  }
  for (const [name, file] of clients) {
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.log(`Left ${name} alone: ${file} isn't valid JSON, so add Pocket there by hand.`);
        continue;
      }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
    config.mcpServers = config.mcpServers || {};
    if (JSON.stringify(config.mcpServers.pocket) === JSON.stringify(server)) {
      console.log(`${name} already has Pocket.`);
      continue;
    }
    config.mcpServers.pocket = server;
    const temp = `${file}.pocket-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(temp, file); // all or nothing: never a half-written config
    console.log(`Added Pocket to ${name}. Restart ${name} to give it the four Pocket tools.`);
  }
}

module.exports = { packagerOptions, installedApp, connectAgents };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
