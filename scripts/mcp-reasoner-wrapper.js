#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

const REAL_BIN = '/usr/bin/mcp-reasoner';

const child = spawn(REAL_BIN, process.argv.slice(2), {
  stdio: ['pipe', 'inherit', 'inherit'],
  env: {
    ...process.env
  }
});

child.on('error', (err) => {
  console.error(`[mcp-reasoner-wrapper] Failed to spawn real binary: ${err.message}`);
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

function toInteger(val, min = 1, max = null, defaultVal = 1) {
  let num = defaultVal;
  if (typeof val === 'number' && !isNaN(val)) {
    num = Math.floor(val);
  } else if (typeof val === 'string') {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed)) {
      num = parsed;
    }
  }
  if (min !== null) num = Math.max(min, num);
  if (max !== null) num = Math.min(max, num);
  return num;
}

const VALID_STRATEGIES = new Set([
  'beam_search',
  'mcts',
  'mcts_002_alpha',
  'mcts_002_alt_alpha',
  'r1_sonnet'
]);

function normalizeReasonerArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') {
    rawArgs = {};
  }

  // 1. Thought
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
    rawThought = 'Reasoning step in progress...';
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
  const thoughtNumber = toInteger(rawThoughtNumber, 1, null, 1);

  // 3. Total thoughts
  const rawTotalThoughts = rawArgs.totalThoughts ??
    rawArgs.total_thoughts ??
    rawArgs.totalSteps ??
    rawArgs.total_steps ??
    rawArgs.maxThoughts ??
    rawArgs.max_thoughts ??
    rawArgs.total ??
    thoughtNumber;
  const totalThoughts = toInteger(rawTotalThoughts, 1, null, Math.max(1, thoughtNumber));

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

  // 5. Strategy type
  let strategyType = rawArgs.strategyType ?? rawArgs.strategy_type ?? rawArgs.strategy ?? 'beam_search';
  if (typeof strategyType === 'string') {
    strategyType = strategyType.trim().toLowerCase().replace(/-/g, '_');
    if (!VALID_STRATEGIES.has(strategyType)) {
      strategyType = 'beam_search';
    }
  } else {
    strategyType = 'beam_search';
  }

  // 6. Beam width
  const beamWidth = toInteger(rawArgs.beamWidth ?? rawArgs.beam_width ?? 3, 1, 10, 3);

  // 7. Num simulations
  const numSimulations = toInteger(rawArgs.numSimulations ?? rawArgs.num_simulations ?? 50, 1, 150, 50);

  return {
    thought: rawThought,
    thoughtNumber: thoughtNumber,
    totalThoughts: Math.max(thoughtNumber, totalThoughts),
    nextThoughtNeeded: nextThoughtNeeded,
    strategyType: strategyType,
    beamWidth: beamWidth,
    numSimulations: numSimulations
  };
}

function normalizeR1Args(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object') {
    rawArgs = {};
  }
  let prompt = rawArgs.prompt ?? rawArgs.thought ?? rawArgs.text ?? rawArgs.content ?? rawArgs.query ?? '';
  if (typeof prompt !== 'string') {
    try {
      prompt = JSON.stringify(prompt);
    } catch {
      prompt = String(prompt || '');
    }
  }
  if (!prompt.trim()) {
    prompt = 'Evaluate reasoning';
  }
  return { prompt };
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
      if (toolName === 'mcpreasonerr1' || toolName === 'reasonerr1' || toolName === 'r1') {
        msg.params.name = 'mcp-reasoner-r1';
        msg.params.arguments = normalizeR1Args(msg.params.arguments);
      } else if (toolName === 'mcpreasoner' || toolName === 'reasoner' || toolName === 'think') {
        msg.params.name = 'mcp-reasoner';
        msg.params.arguments = normalizeReasonerArgs(msg.params.arguments);
      }
    }
    child.stdin.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    child.stdin.write(line + '\n');
  }
});
