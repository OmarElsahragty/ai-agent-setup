#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

const REAL_BIN = '/usr/bin/mcp-server-sequential-thinking';

const child = spawn(REAL_BIN, process.argv.slice(2), {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: {
    ...process.env,
    DISABLE_THOUGHT_LOGGING: process.env.DISABLE_THOUGHT_LOGGING || 'true'
  }
});

child.on('error', (err) => {
  console.error(`[sequential-thinking-wrapper] Failed to spawn real binary: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(code ?? 0);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: child.stdin,
  terminal: false
});

function toBoolean(val, defaultVal = false) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'yes') return true;
    if (lower === 'false' || lower === '0' || lower === 'no') return false;
  }
  if (typeof val === 'number') return val !== 0;
  return defaultVal;
}

function toInteger(val, min = 1, defaultVal = 1) {
  if (typeof val === 'number' && !isNaN(val)) {
    return Math.max(min, Math.floor(val));
  }
  if (typeof val === 'string') {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed)) {
      return Math.max(min, parsed);
    }
  }
  return defaultVal;
}

function normalizeSequentialThinkingArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') {
    rawArgs = {};
  }

  // 1. Thought string
  let rawThought = rawArgs.thought ??
    rawArgs.thought_content ??
    rawArgs.text ??
    rawArgs.content ??
    rawArgs.step ??
    rawArgs.reasoning ??
    rawArgs.analysis ??
    rawArgs.prompt ??
    '';

  if (typeof rawThought !== 'string') {
    if (typeof rawThought === 'object' && rawThought !== null) {
      try {
        rawThought = JSON.stringify(rawThought);
      } catch {
        rawThought = String(rawThought);
      }
    } else {
      rawThought = String(rawThought || '');
    }
  }
  if (!rawThought.trim()) {
    rawThought = 'Thinking step in progress...';
  }

  // 2. Thought number
  const rawThoughtNumber = rawArgs.thoughtNumber ??
    rawArgs.thought_number ??
    rawArgs.stepNumber ??
    rawArgs.step_number ??
    rawArgs.step ??
    rawArgs.thought_num ??
    rawArgs.thoughtIndex ??
    rawArgs.index ??
    1;
  const thoughtNumber = toInteger(rawThoughtNumber, 1, 1);

  // 3. Total thoughts
  const rawTotalThoughts = rawArgs.totalThoughts ??
    rawArgs.total_thoughts ??
    rawArgs.totalSteps ??
    rawArgs.total_steps ??
    rawArgs.maxThoughts ??
    rawArgs.max_thoughts ??
    rawArgs.total ??
    thoughtNumber;
  const totalThoughts = toInteger(rawTotalThoughts, 1, Math.max(1, thoughtNumber));

  // 4. Next thought needed
  const rawNextThought = rawArgs.nextThoughtNeeded ??
    rawArgs.next_thought_needed ??
    rawArgs.needsMoreThoughts ??
    rawArgs.needs_more_thoughts ??
    rawArgs.moreThoughtsNeeded ??
    rawArgs.more_thoughts_needed ??
    rawArgs.continue ??
    false;
  const nextThoughtNeeded = toBoolean(rawNextThought, false);

  const cleanArgs = {
    thought: rawThought,
    thoughtNumber: thoughtNumber,
    totalThoughts: Math.max(thoughtNumber, totalThoughts),
    nextThoughtNeeded: nextThoughtNeeded
  };

  // Optional: isRevision
  const rawIsRevision = rawArgs.isRevision ?? rawArgs.is_revision ?? rawArgs.revision;
  if (rawIsRevision !== undefined && rawIsRevision !== null) {
    cleanArgs.isRevision = toBoolean(rawIsRevision, false);
  }

  // Optional: revisesThought
  const rawRevises = rawArgs.revisesThought ?? rawArgs.revises_thought ?? rawArgs.revising_thought;
  if (rawRevises !== undefined && rawRevises !== null && rawRevises !== '') {
    const num = toInteger(rawRevises, 1, null);
    if (num !== null) cleanArgs.revisesThought = num;
  }

  // Optional: branchFromThought
  const rawBranchFrom = rawArgs.branchFromThought ?? rawArgs.branch_from_thought ?? rawArgs.branch_point;
  if (rawBranchFrom !== undefined && rawBranchFrom !== null && rawBranchFrom !== '') {
    const num = toInteger(rawBranchFrom, 1, null);
    if (num !== null) cleanArgs.branchFromThought = num;
  }

  // Optional: branchId
  const rawBranchId = rawArgs.branchId ?? rawArgs.branch_id;
  if (rawBranchId !== undefined && rawBranchId !== null && String(rawBranchId).trim() !== '') {
    cleanArgs.branchId = String(rawBranchId).trim();
  }

  // Optional: needsMoreThoughts
  const rawNeedsMore = rawArgs.needsMoreThoughts ?? rawArgs.needs_more_thoughts;
  if (rawNeedsMore !== undefined && rawNeedsMore !== null) {
    cleanArgs.needsMoreThoughts = toBoolean(rawNeedsMore, false);
  }

  return cleanArgs;
}

rl.on('line', (line) => {
  if (!line.trim()) {
    child.stdin.write(line + '\n');
    return;
  }

  try {
    const msg = JSON.parse(line);
    if (msg && msg.method === 'tools/call' && msg.params) {
      const toolName = (msg.params.name || '').toLowerCase().replace(/[-_]/g, '');
      if (toolName === 'sequentialthinking' || toolName === 'sequentialthinkingtool' || toolName === 'think') {
        msg.params.name = 'sequentialthinking';
        msg.params.arguments = normalizeSequentialThinkingArgs(msg.params.arguments);
      }
    }
    child.stdin.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    child.stdin.write(line + '\n');
  }
});
