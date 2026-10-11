# ${AI_SETUP_DOMAIN} — quick guide

The web UI runs the same `claude` as your terminal (same router, subagents, hooks,
skills, MCP, CLAUDE.md) and reads the same session files. Login = Cloudflare Access.

## Signing in
1. Cloudflare Access login (your email code) — every new browser/device.
2. On a new device only: CloudCLI's own "Welcome Back" sign-in once — use the login you
   created on 2026-10-06. Behind Access the server also verifies Cloudflare's signed
   token on every request (direct local access gets 401).

## The screen
- **Left sidebar — projects, then sessions.** Each project is a folder Claude Code
  was started in. Click a project to see its sessions (newest first). Use
  *Search projects...* / *Search in conversations...* to find things.
  - **homeLap** — web sessions and, from now on, terminal sessions too.
  - **root** — older terminal sessions (started from `/root`). New terminals now open in
    `${AI_SETUP_ROOT}`, so this list stops growing.
  - Session names are readable titles (set 2026-10-06). Rename any session from its menu.
- **New Session** (top of a project) — starts a fresh conversation in that folder.
- **Main area tabs**
  - **Chat** — talk to Claude. Approvals and questions appear here.
  - **Shell** — a real terminal on the server, in the project folder.
  - **Files** — file tree and editor (*New File*, *New Folder*).
  - **Git / Source Control** — changed files, diffs, branches (*Search branches...*).
  - **Tasks** — task list for the project.
  - **Browser** — built-in page preview.
- **Settings** — model, permissions, appearance. Leave the built-in *Voice*
  setting OFF (our own voice add-on replaces it).

## Everyday flow
1. Pick **homeLap** → **New Session** → type the task.
2. Close the tab whenever you like. The run keeps going on the server (up to 24 h with
   no browser). Reopen the site and click the session to see the output.
3. Check the **Git** tab for what changed.

## Moving between terminal and web
- A terminal session shows up in the web list; click it to continue there.
- A web session continues in the terminal with `cd ${AI_SETUP_ROOT} && claude --resume <id>`,
  or just `claude --resume` and pick it from the list.
- **Use one place at a time.** Close the session in the terminal before continuing it
  on the web (and the other way round). Two writers can corrupt the session file.

## Old sessions
Sessions older than 7 days were moved (not deleted) to
the archived session store (see its RESTORE.md).

## Voice call (Gemini Live, since 2026-10-07)
One **📞** button sits next to the chat box (shown only while the voice service is up).
Tap it to start a call: a slim call bar opens at the top (orb, mute, hang up) and the
chat stays visible and live underneath. Hang up to end.
- You talk in Egyptian Arabic with **Jimmy (جيمي)**, the voice co-worker (Google Gemini
  Live, `gemini-3.8-live`, voice Charon). Jimmy is not Claude: he follows the open session,
  answers "what is it doing?" himself and relays your instructions to Claude (the CEO).
  If Claude is busy he asks whether to interrupt now or to send after it finishes.
- Plans and long messages are read part by part. Approvals and permission answers are
  **never** given by voice: approve or reject on screen.
- Talk over Jimmy to interrupt him; say "كمّل" to let him continue.
- **Mute** stops the mic (Jimmy still answers what you already said).
- **PTT** (push-to-talk, optional, OFF by default): when ON, Jimmy hears you only while
  you hold 🗣️ (it replaces mute) or the Space key; useful with a TV or other people
  talking in the room. The choice is remembered for the next calls; tap PTT again to
  turn it off.
- Audio goes from the browser straight to Google; the API key stays on the server (the
  browser gets a short-lived token from voice-gateway). The call runs while the tab is open.
- Turn the add-on off: `${AI_SETUP_ROOT}/cloudcli-voice/apply.sh --remove`.

## Activity bar (bottom)
Shows the sessions that are working right now, with their subagents and background jobs,
live, with a badge in the sidebar: runs started on the web AND in a terminal. A terminal
session shows while its transcript is being written; with server patch P13 (staged,
pending owner GO) it also shows for as long as its CLI is busy.

## One user only
This site is single-user. Never add a second person to the Cloudflare Access policy or a
second CloudCLI login: the server has no per-user session ownership check, so anyone
signed in could read and drive every session (see README "Multi-user gate").

## Known limits (2026-10-10)
- With PTT off, speech from a TV or other people in the room counts as your speech.
- PTT is not yet verified on a live call (iPhone Safari hold, desktop Space key).
- A second open tab of the same running session was not verified to stream live; reload
  shows everything.
