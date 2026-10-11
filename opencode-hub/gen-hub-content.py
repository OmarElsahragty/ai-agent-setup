#!/usr/bin/env python3
"""Build opencode-hub's public/ tree from the server's single sources of truth:

  wellknown.json   remote OpenCode config served at /.well-known/opencode ("{HUB}" = hub base URL):
                   ONLY the server's quality/cost layer (owner ruling 2026-10-05: the laptop keeps its own
                   subagents, rules, skills, MCP list, providers, models, keys and permissions):
                   plugins homelab-bridge + ponytail, and compaction defaults (laptop values win).
  plugins/         homelab-bridge-<version>.tgz (npm tarball; a content-hash version makes OpenCode
                   download a fresh copy whenever the plugin changes) and ponytail's own `npm pack`
                   tarball (optional: only when PONYTAIL_SKILLS_DIR points at a ponytail checkout)

Usage: gen-hub-content.py [OUT_DIR]   (default: ./public next to this file)
Re-run after editing the plugin or updating ponytail; the hub serves the new files at once.
"""
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
MAC_DIR = os.path.join(HERE, "mac")
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "public"))
PLUGIN_SRC = os.path.join(MAC_DIR, "homelab-bridge.ts")
# ponytail is an OPTIONAL upstream bundle: point PONYTAIL_SKILLS_DIR at its skills/
PONYTAIL_DIR = os.environ.get("PONYTAIL_SKILLS_DIR", "")
# the server's compaction block minus `reserved` (sized for the server's 1M-context models); keep.tokens
# bounds what a compaction keeps verbatim. Laptop config overrides any of these.
COMPACTION = {"auto": True, "prune": True, "tail_turns": 8, "preserve_recent_tokens": 40000}
HUB = "{HUB}"
# baked into the plugin as its default hub (the plugin cannot see the well-known URL); HOMELAB_HUB_URL overrides
PLUGIN_HUB_URL = os.environ.get("OPENCODE_HUB_URL", "http://127.0.0.1:8790").rstrip("/")


def build_plugin(dst: str) -> str:
    source = open(PLUGIN_SRC).read().replace("__HUB_URL__", PLUGIN_HUB_URL)
    version = "1.0.0-" + hashlib.sha256(source.encode()).hexdigest()[:12]
    package = json.dumps({"name": "homelab-bridge", "version": version, "type": "module",
                          "main": "index.ts", "exports": {".": "./index.ts"}}, indent=2).encode()
    filename = f"homelab-bridge-{version}.tgz"
    # mtime=0 and no gzip filename: the same plugin source always produces the same bytes, so the
    # content-hash version is reproducible (two builds of one commit are byte-identical).
    with open(os.path.join(dst, filename), "wb") as fh, \
            gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0) as gz, \
            tarfile.open(fileobj=gz, mode="w") as tar:
        for member, data in (("package/package.json", package), ("package/index.ts", source.encode())):
            info = tarfile.TarInfo(member)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            tar.addfile(info, io.BytesIO(data))
    return filename


def build_ponytail(dst: str) -> str:
    out = subprocess.run(["npm", "pack", "--json", "--pack-destination", dst], cwd=PONYTAIL_DIR,
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)[0]["filename"]


MARKER = os.path.join(OUT, "wellknown.json")
if os.path.islink(OUT):
    sys.exit(f"refusing to replace {OUT}: it is a symlink")
if os.path.lexists(OUT):
    if not os.path.isfile(MARKER):
        sys.exit(f"refusing to replace {OUT}: not a previous build (no wellknown.json)")
    shutil.rmtree(OUT)
os.makedirs(os.path.join(OUT, "plugins"))

plugins = [build_plugin(os.path.join(OUT, "plugins"))]
if PONYTAIL_DIR:
    plugins.append(build_ponytail(os.path.join(OUT, "plugins")))
config = {"plugin": [f"{HUB}/plugins/{p}" for p in plugins], "compaction": COMPACTION}
# `opencode auth login <hub>` needs an auth command; the hub itself is unauthenticated (owner ruling
# 2026-10-05), so the "token" is only a marker that this machine is wired to the homelab.
wellknown = {"auth": {"command": ["echo", os.environ.get("OPENCODE_HUB_TOKEN", "")],
                      "env": "OPENCODE_HUB_TOKEN"}, "config": config}
text = json.dumps(wellknown, indent=2, ensure_ascii=False)
if re.search(r'"(apiKey|api_key|token|password)"\s*:', text, re.I):
    sys.exit("credential-shaped key in wellknown.json")
open(MARKER, "w").write(text + "\n")
print(f"built {OUT}: plugins={plugins} compaction={COMPACTION}")
