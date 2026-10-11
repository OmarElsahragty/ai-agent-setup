#!/usr/bin/env bash
# P15: Antigravity (agy) CLI provider integration for @cloudcli-ai/cloudcli 1.37.3
# Usage:
#   apply.d/p15.sh [TARGET_ROOT]          apply (idempotent; completes a partial apply)
#   apply.d/p15.sh --check [TARGET_ROOT]  verify every P15 edit, change nothing; exit 1 if any is missing
set -euo pipefail

MODE=apply
if [ "${1:-}" = "--check" ]; then MODE=check; shift; fi
PATCHES_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ $# -ge 1 ]; then cd "$1"; else cd "$PATCHES_DIR/.."; fi
PKG="node_modules/@cloudcli-ai/cloudcli"
[ -d "$PKG" ] || { echo "FATAL: $PKG not found under $(pwd)" >&2; exit 1; }

# Verify system symlink exists
if [ ! -x "/usr/local/bin/agy" ]; then
    if [ "$MODE" = "check" ]; then
        echo "[check] MISSING: /usr/local/bin/agy executable not found" >&2
        exit 1
    else
        ln -sf "${AGY_BIN:-$(command -v agy || echo "$HOME/.local/bin/agy")}" /usr/local/bin/agy
    fi
fi

# Run node script for file copy and text patches
node - "$MODE" "$PKG" "$PATCHES_DIR/files/agy" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [mode, pkg, filesDir] = process.argv.slice(2);
const checkOnly = mode === 'check';
let failures = 0;

function note(msg) { console.log(`[${mode}] ${msg}`); }
function missing(msg) { console.error(`[${mode}] MISSING: ${msg}`); failures++; }

// 1. Files in dist-server/server/modules/providers/list/agy
const agyDir = path.join(pkg, 'dist-server/server/modules/providers/list/agy');
const requiredFiles = [
    'agy.provider.js',
    'agy-runtime.provider.js',
    'agy-models.provider.js',
    'agy-auth.provider.js',
    'agy-sessions.provider.js',
    'agy-session-synchronizer.provider.js',
    'agy-skills.provider.js',
    'agy-mcp.provider.js',
];

if (!checkOnly) {
    fs.mkdirSync(agyDir, { recursive: true });
    for (const file of requiredFiles) {
        const src = path.join(filesDir, file);
        const dest = path.join(agyDir, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
        }
    }
}

for (const file of requiredFiles) {
    if (fs.existsSync(path.join(agyDir, file))) {
        note(`P15 agy file present: ${file}`);
    } else {
        missing(`P15 agy file missing: ${file}`);
    }
}

// 2. Patch provider.registry.js
const registryPath = path.join(pkg, 'dist-server/server/modules/providers/provider.registry.js');
let registrySrc = fs.readFileSync(registryPath, 'utf8');
if (registrySrc.includes('agy: new AgyProvider()')) {
    note('P15 providerRegistry has agy');
} else if (!checkOnly) {
    const importAnchor = "import { OpenCodeProvider } from '../../modules/providers/list/opencode/opencode.provider.js';";
    const importAdd = "\nimport { AgyProvider } from '../../modules/providers/list/agy/agy.provider.js';";
    const mapAnchor = "opencode: new OpenCodeProvider(),";
    const mapAdd = "\n    agy: new AgyProvider(),";
    if (registrySrc.includes(importAnchor) && registrySrc.includes(mapAnchor)) {
        registrySrc = registrySrc.replace(importAnchor, importAnchor + importAdd);
        registrySrc = registrySrc.replace(mapAnchor, mapAnchor + mapAdd);
        fs.writeFileSync(registryPath, registrySrc, 'utf8');
        note('P15 providerRegistry patched with agy');
    } else {
        missing('P15 providerRegistry missing anchors');
    }
} else {
    missing('P15 providerRegistry missing agy');
}

// 3. Patch provider-capabilities.service.js
const capsPath = path.join(pkg, 'dist-server/server/modules/providers/services/provider-capabilities.service.js');
let capsSrc = fs.readFileSync(capsPath, 'utf8');
if (capsSrc.includes("provider: 'agy'")) {
    note('P15 providerCapabilitiesService has agy');
} else if (!checkOnly) {
    const capsAnchor = "        supportsSessionForking: false,\n    },";
    const capsAdd = `\n    agy: {
        provider: 'agy',
        permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
        defaultPermissionMode: 'default',
        supportsImages: true,
        supportsFiles: true,
        supportsAbort: true,
        supportsPermissionRequests: false,
        supportsTokenUsage: true,
        supportsEffort: true,
        supportsMessageEditing: false,
        supportsSessionForking: false,
    },`;
    if (capsSrc.includes(capsAnchor)) {
        capsSrc = capsSrc.replace(capsAnchor, capsAnchor + capsAdd);
        fs.writeFileSync(capsPath, capsSrc, 'utf8');
        note('P15 providerCapabilitiesService patched with agy');
    } else {
        missing('P15 providerCapabilitiesService missing anchor');
    }
} else {
    missing('P15 providerCapabilitiesService missing agy');
}

// 4. Patch provider.routes.js
const routesPath = path.join(pkg, 'dist-server/server/modules/providers/provider.routes.js');
let routesSrc = fs.readFileSync(routesPath, 'utf8');
if (routesSrc.includes("|| normalized === 'agy'")) {
    note('P15 provider.routes.js allows agy');
} else if (!checkOnly) {
    const routeAnchor = "|| normalized === 'opencode')";
    const routeAdd = "|| normalized === 'opencode'\n        || normalized === 'agy')";
    if (routesSrc.includes(routeAnchor)) {
        routesSrc = routesSrc.replace(routeAnchor, routeAdd);
        fs.writeFileSync(routesPath, routesSrc, 'utf8');
        note('P15 provider.routes.js patched with agy');
    } else {
        missing('P15 provider.routes.js missing anchor');
    }
} else {
    missing('P15 provider.routes.js missing agy in parseProvider');
}

// 5. Patch sessions-watcher.service.js
const watcherPath = path.join(pkg, 'dist-server/server/modules/providers/services/sessions-watcher.service.js');
let watcherSrc = fs.readFileSync(watcherPath, 'utf8');
if (watcherSrc.includes("provider: 'agy'")) {
    note('P15 sessions-watcher.service.js watches agy');
} else if (!checkOnly) {
    const watcherAnchor = "rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),\n    },";
    const watcherAdd = `\n    {
        provider: 'agy',
        rootPath: path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
    },`;
    if (watcherSrc.includes(watcherAnchor)) {
        watcherSrc = watcherSrc.replace(watcherAnchor, watcherAnchor + watcherAdd);
        fs.writeFileSync(watcherPath, watcherSrc, 'utf8');
        note('P15 sessions-watcher.service.js patched with agy');
    } else {
        missing('P15 sessions-watcher.service.js missing anchor');
    }
} else {
    missing('P15 sessions-watcher.service.js missing agy');
}

if (failures > 0) {
    console.error(`P15 failed with ${failures} errors`);
    process.exit(1);
}
console.log('P15 OK');
NODE
