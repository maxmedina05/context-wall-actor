# ContextWall Firewall — Apify Actor

## What this is

Apify actor that wraps any other Apify scraper actor and acts as a data firewall. Agent calls this actor instead of calling the scraper directly. Actor validates the scraper output stream, and aborts the upstream run the moment toxic data is detected — before it poisons the agent's context window.

## Origin

Ported from the MCP server version at `/Users/medma/Projects/personal/context-wall-poc/context-wall-hackathon`. That repo has the full problem description, architecture diagrams, and working demos. Read `OVERVIEW.md` there for full context on the problem being solved.

## Why Apify actor instead of MCP server

- No infrastructure to host — Apify runs it
- Publish to Apify Store → any agent/user can use it
- Apify's own MCP server (`mcp.apify.com`) auto-exposes it as an MCP tool to agents — zero custom MCP code needed

## How agent uses it

Agent configures Apify's MCP server once:

```json
{
  "mcpServers": {
    "apify": {
      "url": "https://mcp.apify.com/sse",
      "headers": { "Authorization": "Bearer <APIFY_TOKEN>" }
    }
  }
}
```

Then calls the tool `<username>/context-wall-firewall` with:

```json
{
  "intent": "restaurants in NYC that offer delivery",
  "actorId": "apify/google-maps-scraper",
  "actorInput": { "searchQuery": "restaurants NYC", "maxResults": 50 },
  "requiredFields": ["name", "address"],
  "geminiApiKey": "<secret>"
}
```

Actor returns inline in `OUTPUT` key (agent gets it as MCP tool response):

```json
{
  "ok": false,
  "tier": "tier1",
  "reason": "blocklist_keyword",
  "detail": "Item #0 contains block-page signal: \"Cloudflare\".",
  "stats": { "itemsStreamed": 1, "itemsDelivered": 0, "aborted": true, "upstreamRunId": "..." },
  "data": []
}
```

## Architecture

```
Agent
  └── Apify MCP Server (mcp.apify.com, managed by Apify)
        └── ContextWall Actor (this repo, runs on Apify cloud)
              ├── starts target scraper actor via apify-client
              ├── polls dataset while run is in-progress
              ├── Tier 1: per-item, regex blocklist + shape check (~ms, no LLM)
              ├── Tier 2: LLM judge on 3-item sample, runs concurrently
              └── AbortController → calls client.run(id).abort() on bad data
```

## Key design decisions (already decided)

- **Output inline in `OUTPUT` key** (not dataset pointer). Actor aborts early so dataset is never huge. Agent gets verdict + clean items in single MCP tool response.
- **Polling not true streaming**. Apify actors can't stream; we poll the live dataset at 750ms intervals while the upstream run is RUNNING. Same abort logic as MCP version.
- **Fail-closed on LLM error**. Tier 2 degrades to keyword heuristic if Gemini key missing or call fails — never waves data through.
- **Gemini key as actor secret input**. Passed in `geminiApiKey` field (marked `isSecret` in schema), surfaced to `process.env.GEMINI_API_KEY` at runtime.
- **`apify-client` uses `Actor.getEnv().token`**. Actor gets its own Apify token injected at runtime — no extra secrets needed to call other actors.

## Current scaffold state

Files already written:

```
.actor/
  actor.json          — actor metadata (name, title, description)
  input_schema.json   — typed input schema with all fields
src/
  main.ts             — entry point (Actor.init / poll loop / trip breaker / Actor.exit)
  llm.ts              — Gemini judge (adapted from hackathon repo providers/llm.ts)
  firewall/
    verdict.ts        — Verdict type + pass() / block() helpers
    tier1.ts          — mechanical per-item check (blocklist + shape)
    tier2.ts          — LLM judge orchestrator + keyword heuristic fallback
package.json          — deps: apify, apify-client, @google/genai
tsconfig.json         — ESM, NodeNext, strict
```

## What still needs to be done

1. **Test locally** — `npm run dev` against the mock actor from the hackathon repo (`apify/context-wall-mock-actor` or local mock). Verify all three scenarios: clean pass, Tier 1 block, Tier 2 block.

2. **Add `.gitignore`** — `node_modules/`, `dist/`, `.env`.

3. **Add `Dockerfile`** — Apify standard Node.js actor Dockerfile (base image `apify/actor-node:20`). Required for `apify push`.

4. **Deploy to Apify** — `npx apify-cli push`. Needs `APIFY_TOKEN` in env.

5. **Verify via Apify MCP** — configure `mcp.apify.com` in Claude Code or another agent, call the tool, confirm verdict comes back in tool response.

6. **Optional: add `README.md`** — for Apify Store listing.

## Reference

- Hackathon repo (MCP version, working): `/Users/medma/Projects/personal/context-wall-poc/context-wall-hackathon`
- Apify actor SDK docs: https://docs.apify.com/sdk/js/
- Apify MCP server docs: https://docs.apify.com/platform/integrations/mcp
- Apify CLI: `npm install -g apify-cli` then `apify login`
