#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const path = require('path');

const REAL_BIN = '/usr/bin/testsprite-mcp-plugin';
const AI_SETUP_ROOT = process.env.AI_SETUP_ROOT || path.resolve(__dirname, '..');
const ENV_FILE = path.join(AI_SETUP_ROOT, '.env');

function loadApiKey() {
  if (process.env.TESTSPRITE_API_KEY) {
    return process.env.TESTSPRITE_API_KEY;
  }
  if (process.env.API_KEY) {
    return process.env.API_KEY;
  }
  try {
    if (fs.existsSync(ENV_FILE)) {
      const content = fs.readFileSync(ENV_FILE, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const [key, ...rest] = trimmed.split('=');
        const val = rest.join('=').trim().replace(/^["']|["']$/g, '');
        if (key.trim() === 'TESTSPRITE_API_KEY' && val) {
          return val;
        }
      }
    }
  } catch (err) {
    console.error(`[testsprite-wrapper] Warning: Failed to read ${ENV_FILE}: ${err.message}`);
  }
  return '';
}

const apiKey = loadApiKey();

const env = {
  ...process.env,
  TESTSPRITE_API_KEY: apiKey || process.env.TESTSPRITE_API_KEY || '',
  API_KEY: apiKey || process.env.API_KEY || ''
};

const child = spawn(REAL_BIN, process.argv.slice(2), {
  stdio: 'inherit',
  env
});

child.on('error', (err) => {
  console.error(`[testsprite-wrapper] Failed to spawn real binary: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
