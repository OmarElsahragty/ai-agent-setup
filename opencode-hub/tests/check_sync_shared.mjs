// Imports a COPY of OpenCode's sync-shared.ts plugin, builds its config and checks every MCP entry:
//   node --no-warnings check_sync_shared.mjs <plugin.ts> header|none
// "header": each entry carries Authorization = "Bearer " + the token in $OPENCODE_HUB_TOKEN_FILE;
// "none": no entry carries Authorization. Prints counts only, never the token. Exit 0 = as expected.
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const [plugin, expect] = process.argv.slice(2)
const mod = await import(pathToFileURL(plugin).href)
const hooks = await mod.default({ client: null, directory: process.cwd() })
const cfg = {}
await hooks.config(cfg)
const entries = Object.values(cfg.mcp ?? {})
const wanted = expect === "header"
  ? "Bearer " + readFileSync(process.env.OPENCODE_HUB_TOKEN_FILE, "latin1").trim()
  : undefined
let withHeader = 0
let matching = 0
for (const entry of entries) {
  const value = entry?.headers?.Authorization
  if (value !== undefined) withHeader++
  if (value === wanted) matching++
}
console.log(JSON.stringify({ entries: entries.length, withHeader, matching }))
process.exit(entries.length > 0 && matching === entries.length ? 0 : 1)
