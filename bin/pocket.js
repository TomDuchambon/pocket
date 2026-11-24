#!/usr/bin/env node
'use strict';
// `pocket [port | /path | url]` opens Pocket and hands the terminal back.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE_ID = 'dev.tomduchambon.pocket';

// The installed Pocket.app if there is one (and it really is ours), else run from source.
function installedApp() {
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const app = path.join(dir, 'Pocket.app');
    try {
      if (fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(BUNDLE_ID)) {
        return path.join(app, 'Contents', 'MacOS', 'Pocket');
      }
    } catch {
      // not there
    }
  }
  return null;
}

const binary = installedApp();
const args = binary ? [] : [path.join(__dirname, '..')];
if (process.argv[2]) args.push(`--pocket-target=${process.argv[2]}`);

spawn(binary || require('electron'), args, { detached: true, stdio: 'ignore' }).unref();
