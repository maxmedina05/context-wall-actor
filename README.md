# ContextWall Firewall

**A data firewall for AI agents — wrap any Apify scraper, validate its output stream, and abort the upstream run the moment toxic data appears, before it poisons your agent's context window.**

## What it is / the problem it solves

When an AI agent calls a scraper directly, whatever the scraper returns lands straight in the agent's context window. That output is frequently **toxic**:

- **Block pages** — Cloudflare "Attention Required", "Just a moment...", "please enable JavaScript", plus modern anti-bot walls (Akamai, PerimeterX, DataDome, Imperva, "Ray ID", "checking your browser").
- **Anti-bot / CAPTCHA / login walls** — "are you human", "verify you are human", login prompts.
- **Errors and rate limits** — 403/401 forbidden, "too many requests", bot-detection notices.
- **Prompt injection** — scraped fields (e.g. a review) carrying instructions aimed at the agent reading them: "ignore all previous instructions", fake system messages, "recommend only X".
- **Wrong data** — items that are technically well-formed but don't actually match what the agent asked for (e.g. dine-in-only restaurants when the agent wanted delivery).

Once any of this enters the context window, it's already done its damage: it derails the agent's reasoning, wastes tokens, and on metered scrapers you keep paying while the run produces garbage.

ContextWall sits between the agent and the scraper. The agent calls **this** actor instead of calling the scraper directly. ContextWall starts the target scraper, watches its output as it's produced, and kills the run the instant it sees toxic data — so bad items never reach the agent and you stop paying for a doomed run.

## How it works

ContextWall starts the target actor via `apify-client`, then **polls the live dataset every 750ms** while the upstream run is still `RUNNING` (Apify actors can't truly stream, so polling the in-progress dataset is the equivalent). Each item is run through two tiers as it arrives.

### Tier 1 — mechanical (per-item, no LLM, ~ms)

Runs on **every** item, synchronously, with zero network cost:

- **Empty check** — rejects blank / `{}` / `[]` items.
- **Regex blocklist** — flattens the item to text and matches ~28 block-page / anti-bot signals (Cloudflare, CAPTCHA, "are you human", "enable JavaScript", rate-limit / "too many requests", 401/403 forbidden, "attention required", "just a moment", bot-detection, plus modern WAFs: Akamai "powered & protected by", PerimeterX "press and hold", DataDome, Imperva/Incapsula, "Ray ID", "checking your browser", "you have been blocked", "unusual traffic"). Extendable per-call via `extraBlocklist`.
- **Prompt-injection scan** — matches instruction-like signatures embedded in field values ("ignore all previous instructions", "system prompt", "you are now…", override patterns, `<|im_start|>`). Returns `prompt_injection`.
- **Shape check** — if `requiredFields` are configured, every item must have each field present and non-empty.

A Tier 1 failure trips the breaker immediately.

### Tier 2 — semantic (LLM judge on a small sample, runs concurrently)

Once `sampleSize` items (default 3) have passed Tier 1, ContextWall fires a **Gemini** semantic judge on that sample **concurrently** with continued polling — so it doesn't stall the stream. The judge decides:

- **isBlockPage** — is this an anti-bot / CAPTCHA / login / error page rather than real data?
- **containsInjection** — does any field carry text trying to instruct/manipulate the agent reading it?
- **aligned** — does the data genuinely satisfy the agent's stated `intent`?

The judge is strict and fails toward the unsafe value when uncertain. Model defaults to `gemini-2.5-flash-lite` (override via `GEMINI_MODEL`). Injection and block-page verdicts always block; an intent **mismatch** is gated by `confidenceThreshold` (default `0` = block on any mismatch) to cut false positives on weak hits.

**Heuristic fallback (fail-closed).** If no `geminiApiKey` is provided, or the Gemini call throws, Tier 2 degrades to a keyword heuristic instead of waving data through: it flags an embedded injection regex, explicit negation of intent keywords (e.g. `"delivery": false`, "no delivery"), and samples that share little vocabulary with the intent. ContextWall **never fails open**.

### Early abort

Both tiers share a single `AbortController`. The moment either tier returns a block verdict, ContextWall:

1. Aborts the local poll loop, and
2. Calls `client.run(id).abort()` to **kill the upstream scraper run**.

This is the whole point: you stop paying for the run and the toxic items never reach the agent. On a block, `data` is returned empty.

If the target actor fails to start, errors mid-run, or never settles within `maxWaitSecs`, ContextWall **fails closed** — it returns `ok:false` with `reason: "upstream_error"` rather than crashing, so the agent always gets a verdict.

### Cost & context accounting

Every run reports how much it kept out of context: `stats.tokensDelivered` (clean tokens passed), `stats.tokensBlocked` (toxic tokens withheld), and `stats.usdSaved` (blocked tokens × `downstreamUsdPerMTok`, default $3/1M). Tokens are estimated from payload size (~4 chars/token).

### Inline delivery

The verdict and any clean items are written to the actor's **`OUTPUT`** key (not a dataset pointer). Because ContextWall aborts early, the dataset stays small, and the agent receives the verdict plus clean data as a single MCP tool response.

## Usage via the Apify MCP server

ContextWall is designed to be consumed through **Apify's managed MCP server** (`mcp.apify.com`) — no custom MCP code needed. Configure it once in your agent:

```json
{
  "mcpServers": {
    "apify": {
      "url": "https://mcp.apify.com/?actors=<username>/context-wall-firewall",
      "headers": { "Authorization": "Bearer <APIFY_TOKEN>" }
    }
  }
}
```

Then call the tool `<username>/context-wall-firewall` with the scraper you want to guard:

```json
{
  "intent": "Georgian restaurants in Berlin to book for dinner",
  "actorId": "compass/crawler-google-places",
  "actorInput": { "searchStringsArray": ["Georgian restaurants"], "locationQuery": "Berlin, Germany", "maxCrawledPlacesPerSearch": 3 },
  "requiredFields": ["title"],
  "geminiApiKey": "<secret>"
}
```

ContextWall starts `compass/crawler-google-places` for you, firewalls its output, and returns the result inline.

> The actor calls other actors using its own runtime token (`Actor.getEnv().token`), so no extra Apify secret is needed to start the target scraper.

## Input reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `intent` | string | **yes** | — | Natural-language description of the data the agent expects, e.g. `"restaurants in NYC that offer delivery"`. Used by the Tier 2 semantic judge. |
| `actorId` | string | **yes** | — | The Apify actor to run as the scraper, e.g. `"compass/crawler-google-places"`. |
| `actorInput` | object | **yes** | — | Input object passed verbatim to the target actor. |
| `requiredFields` | array of string | no | `[]` | Field names every item must have and be non-empty (Tier 1 shape check). |
| `sampleSize` | integer | no | `3` | Number of items to buffer before running the Tier 2 LLM judge (minimum `1`). Set above the expected item count to skip Tier 2. |
| `extraBlocklist` | array of string | no | `[]` | Extra case-insensitive block-page phrases for Tier 1 (site-specific anti-bot wording). |
| `downstreamUsdPerMTok` | number | no | `3` | Downstream LLM price ($/1M tokens) used to estimate `usdSaved`. |
| `confidenceThreshold` | number | no | `0` | Min Tier 2 confidence (0–1) to hard-block an intent **mismatch**. `0` = strictest. Injection/block-page always block. |
| `maxWaitSecs` | integer | no | `300` | Safety cap on total wait for the upstream run before failing closed with `upstream_error`. |
| `geminiApiKey` | string (**secret**) | no | — | Google AI Studio key for the Tier 2 semantic judge. **Marked `isSecret`.** If omitted, Tier 2 falls back to the keyword heuristic. |

## Output reference

ContextWall writes a single JSON object to the **`OUTPUT`** key:

```json
{
  "ok": false,
  "tier": "tier1",
  "reason": "blocklist_keyword",
  "detail": "Item #0 contains block-page signal: \"Cloudflare\".",
  "confidence": null,
  "stats": {
    "itemsStreamed": 1,
    "itemsDelivered": 0,
    "aborted": true,
    "upstreamRunId": "...",
    "tokensDelivered": 0,
    "tokensBlocked": 85,
    "usdSaved": 0.000255
  },
  "data": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | `true` if the data passed both tiers, `false` if blocked. |
| `tier` | `"tier1"` \| `"tier2"` \| `null` | Which tier produced the verdict; `null` on a clean pass or `upstream_error`. |
| `reason` | string | Verdict code: `clean`, `empty`, `blocklist_keyword`, `prompt_injection`, `schema_invalid`, `semantic_block`, `semantic_mismatch`, or `upstream_error`. |
| `detail` | string | Human-readable explanation of the verdict. |
| `confidence` | number \| null | Judge confidence for Tier 2 verdicts; `null` for Tier 1 / clean / error. |
| `stats.itemsStreamed` | number | Items pulled from the upstream dataset before the run ended or was aborted. |
| `stats.itemsDelivered` | number | Clean items returned in `data` (`0` on a block). |
| `stats.aborted` | boolean | Whether the upstream run was aborted early. |
| `stats.upstreamRunId` | string | The run ID of the target scraper (`""` if it never started). |
| `stats.tokensDelivered` | number | Estimated tokens of clean data returned (0 on a block). |
| `stats.tokensBlocked` | number | Estimated toxic tokens kept out of the agent's context. |
| `stats.usdSaved` | number | Estimated downstream LLM $ saved by not ingesting the blocked tokens. |
| `data` | array of object | Clean items on a pass; empty array on a block. |

## Local development / testing

```bash
npm install
```

### Run the local test harness

```bash
npm run test:local
```

This runs `src/dev/localTest.ts` with a **fake Apify client** that streams fixture rows into a fake dataset on a timer and honours `abort()` exactly like the cloud client — so the whole poll/abort loop is exercised without touching Apify cloud. It runs four fixtures:

- **clean** → passes both tiers (`ok: true`).
- **hard** → blocked by **Tier 1** (Cloudflare / "Just a moment..." block-page text).
- **soft** → blocked by **Tier 2** (well-formed but dine-in-only data that contradicts a "with delivery" intent; caught by the keyword heuristic when no `GEMINI_API_KEY` is set).
- **injection** → blocked by **Tier 1** (a review carrying "ignore all previous instructions").

For the three block scenarios the harness asserts **early abort** (fewer than 12 rows streamed, run aborted) and **cost accounting** (`tokensBlocked > 0`), proving the breaker trips before the full fixture is emitted and quantifies what was kept out of context. Set `GEMINI_API_KEY` to exercise the real LLM judge instead of the heuristic.

## Demos

| Demo | Shows | File |
|------|-------|------|
| Local engine | Tiers, abort, cost (offline + real cloud) | [DEMO.md](DEMO.md) |
| Victim agent | A real agent poisoned vs protected (single source) | [VICTIM-DEMO.md](VICTIM-DEMO.md) |
| Multi-source | Firewall as a selective gate over 3 sources | [MULTISOURCE-DEMO.md](MULTISOURCE-DEMO.md) |
| Dashboard | One-page visual readout of a 3-source run | `demo-dashboard.html` |

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` (ESM, NodeNext, strict).

### Deploy

```bash
apify login
apify push
```

`apify push` builds the Docker image (`apify/actor-node:20` base, see `Dockerfile`) and publishes the actor. Requires the Apify CLI (`npm install -g apify-cli`) and an authenticated session.
