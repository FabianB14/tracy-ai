# Tracy's tools on your desktop (MCP)

Run Tracy's operator tools from an agent on your own machine — OpenClaw,
Claude Code, anything that speaks MCP.

**Why:** talking to hosted Tracy spends Anthropic API credit, because her
brain is an API call. A desktop agent already has a brain you pay for
another way (a Claude subscription via `claude setup-token`). This server
hands that agent Tracy's **tools without her brain**, so operator work —
test kits, platform switches, BabyResell numbers — costs no API credit.

It reuses the exact schemas and handlers from `src/tools.js`, so these tools
can't drift from the ones Tracy uses in chat. **Nothing here calls a model.**
Every handler is a direct HTTPS call to the INTERVERSE admin API or the
BabyResell API, authenticated by the keys in this process's environment.

## What you get (14 tools)

- **Platform switches** — `get_ai_lane_status`, `set_ai_conversion`,
  `set_test_kits`, `set_metadata_quality`
- **Test kits** — `create_test_kit` (fresh games, or wrap your own with
  `game_ids`), `get_test_kit`, `cleanup_test_kit`
- **BabyResell** — stats, activity, moderation queue, shipping backlog,
  plus the listing helpers

Deliberately **not** exposed: Tracy's memory, vault, and knowledge tools.
Those belong to her brain; your desktop agent has its own.

## Setup (about 3 minutes)

1. **Clone and install** (once):

   ```bash
   git clone https://github.com/FabianB14/tracy-ai.git
   cd tracy-ai && npm install
   ```

2. **Make a `.env` next to it** with the operator keys. These are the same
   values Tracy uses on Render — copy them from that service:

   ```
   INTERVERSE_API_URL=https://<your interverse-api host>
   INTERVERSE_ADMIN_KEY=<the backend's ADMIN_REGISTRATION_KEY>
   ADMIN_USER_IDS=<your Tracy admin userId>
   BABYRESELL_API_URL=<optional, for the BabyResell tools>
   BABYRESELL_ADMIN_KEY=<optional>
   ```

   No `ANTHROPIC_API_KEY` is needed — that's the point.

3. **Point your agent at it.** Standard MCP stdio config, which most clients
   accept in a JSON config file:

   ```json
   {
     "mcpServers": {
       "tracy-tools": {
         "command": "node",
         "args": ["/absolute/path/to/tracy-ai/mcp/server.js"],
         "env": {
           "INTERVERSE_API_URL": "https://<your interverse-api host>",
           "INTERVERSE_ADMIN_KEY": "<admin key>",
           "ADMIN_USER_IDS": "<your admin userId>"
         }
       }
     }
   }
   ```

   Check your client's docs for where that file lives (OpenClaw keeps its
   config under its own config directory). For **Claude Code** the one-liner
   is:

   ```bash
   claude mcp add tracy-tools -- node /absolute/path/to/tracy-ai/mcp/server.js
   ```

   Env values can come from the config block above or from the `.env`.

4. **Check it:** `npm run mcp` should print
   `[tracy-tools] ready — 14 tools exposed` to stderr and then wait. That
   wait is correct — it's listening for MCP on stdin. Ctrl-C to exit.

## Then just ask

> "Give me a test kit for my two games, then turn the AI lane off."

The agent calls `create_test_kit` and `set_ai_conversion` through this
server. Same tools, same admin key, no API meter running.

## Notes

- **Keys stay local.** They live in your `.env` or your client's config on
  your machine. Don't paste them into a chat with Tracy or anyone else.
- **This is the real admin key**, so this agent can flip production
  switches. Treat the machine accordingly, and prefer a scoped
  `/admin/config`-only credential once one exists.
- Startup complaints print to **stderr** on purpose: stdout is the MCP
  protocol channel and anything written there corrupts the stream.
- A "not connected" reply mentioning "Tracy's server" means the env vars
  above are missing **here** — that message is shared with her chat path.
