# ContextWall Firewall — Demo Walkthrough

There are **two kinds of demo**:

| Kind | What it shows | Where |
|------|---------------|-------|
| **Local runs** (this file) | The firewall engine itself — tiers, abort, cost accounting | `npm` commands here |
| **Agent-via-MCP demos** | A real AI agent getting poisoned / protected through the Apify MCP tool | [VICTIM-DEMO.md](VICTIM-DEMO.md), [MULTISOURCE-DEMO.md](MULTISOURCE-DEMO.md) |
| **Dashboard** | A one-page visual readout of a 3-source run | open `docs/index.html` (or GitHub Pages) |

The agent demos run from two dedicated folders (outside this repo) so a fresh
Claude Code session has no project context:

| Folder | MCP config | Role |
|--------|-----------|------|
| `~/Projects/personal/demo-protected/` | locked `.mcp.json` — **firewall only**, raw scrapers unreachable | protected / Leg C |
| `~/Projects/personal/demo-unprotected/` | global `~/.claude.json` — raw scrapers exposed | unprotected / Leg A |

See [VICTIM-DEMO.md](VICTIM-DEMO.md) (single-source poisoning) and
[MULTISOURCE-DEMO.md](MULTISOURCE-DEMO.md) (3-source selective gate) for the exact
prompts and setup. The rest of this file is the **local engine** demos.

---

## Local demos at a glance

| Demo | What it proves | Needs cloud? | Needs keys? |
|------|----------------|--------------|-------------|
| A — Offline (fake client) | All 4 scenarios: clean / block-page / mismatch / injection + early abort + cost accounting | No | No |
| B — Real cloud, clean path | Firewall starts/polls/aborts a live Apify actor | Yes | `APIFY_TOKEN` |
| C — Real Tier 2 block (LLM) | Gemini judge rejects a real intent mismatch | Yes | `APIFY_TOKEN` + `GEMINI_API_KEY` |

---

## Demo A — Offline, deterministic (start here)

No token, no credits, no network. A fake Apify client streams four fixtures
row-by-row and honours abort like the real cloud.

```bash
npm install
npm run test:local
```

**Expected output (abridged — 4 scenarios, each with a verdict + cost line):**

```
================ scenario: clean ================
  RESULT ok=true tier=null reason=clean delivered=12/12 aborted=false
  COST   tokensDelivered=291 tokensBlocked=0 usdSaved=$0
  ✅ PASS

================ scenario: hard ================            (Cloudflare block-page text)
  [Tier 1 BLOCK] item #0: ... block-page signal: "Cloudflare".
  RESULT ok=false tier=tier1 reason=blocklist_keyword delivered=0/1 aborted=true
  COST   tokensDelivered=0 tokensBlocked=41 usdSaved=$0.000123
  ✅ PASS

================ scenario: soft ================            (valid data, wrong intent)
  [Tier 2] verdict: BLOCK — Judge: Sample negates requested feature "delivery" (heuristic).
  RESULT ok=false tier=tier2 reason=semantic_mismatch delivered=0/3 aborted=true
  COST   tokensDelivered=0 tokensBlocked=120 usdSaved=$0.00036
  ✅ PASS

================ scenario: injection ================       (prompt injection in a review)
  [Tier 1 BLOCK] item #0: ... prompt-injection signal: "ignore all previous instructions".
  RESULT ok=false tier=tier1 reason=prompt_injection delivered=0/1 aborted=true
  COST   tokensDelivered=0 tokensBlocked=56 usdSaved=$0.000168
  ✅ PASS

✅ ALL SCENARIOS PASSED
```

**Read it:**
- **clean** — 12 valid rows, both tiers pass, all 12 delivered, no abort.
- **hard** — perfectly-shaped JSON whose *values* are Cloudflare block-page text.
  Tier 1 catches it at item #0 → aborted after **1 of 12** rows. A naive schema check waves this through.
- **soft** — valid restaurant data but the opposite of the intent. Tier 2
  (heuristic, no key) blocks after the 3-item sample → aborted at **3 of 12**.
- **injection** — valid-looking rows where item #0's review carries "ignore all
  previous instructions". Tier 1 injection regex blocks at item #0.

Each block shows `aborted=true`, `streamed < 12`, and `tokensBlocked > 0` — the
breaker trips **before** the upstream finishes, and the cost line quantifies the
toxic tokens kept out of context.

---

## Demo B — Real Apify cloud, clean path

Runs the firewall **locally** while it starts and polls a **real** scraper on
Apify cloud. (Costs a few Apify credits; `maxCrawledPlacesPerSearch: 3` keeps it tiny.)

### Setup

```bash
cp .env.example .env          # then edit .env, set APIFY_TOKEN=apify_api_...
cp INPUT.example.json storage/key_value_stores/default/INPUT.json
```

The input ([INPUT.example.json](INPUT.example.json)) targets the real Google Maps
scraper with a query that matches the intent (clean pass):

```json
{
  "intent": "Georgian restaurants in Berlin, Germany",
  "actorId": "compass/crawler-google-places",
  "actorInput": { "searchStringsArray": ["Georgian restaurants"], "locationQuery": "Berlin, Germany", "maxCrawledPlacesPerSearch": 3, "language": "en" },
  "requiredFields": ["title", "address"],
  "sampleSize": 3
}
```

> Tip: to isolate the pure plumbing path with **no LLM**, set `sampleSize` above
> the item count (e.g. 10) — the sample never fills, so Tier 2 never fires.

### Run

```bash
npm run dev:real      # tsx --env-file=.env src/main.ts
# or via the Apify CLI:
apify run
```

**Expected console (abridged):**

```
Starting target actor: compass/crawler-google-places
Upstream run started: <realRunId>
Done. verdict=PASS delivered=3/3 items | tokensDelivered=3864 tokensBlocked=0 usdSaved=$0
```

**Expected result** — `storage/key_value_stores/default/OUTPUT.json`:

```json
{
  "ok": true,
  "tier": null,
  "reason": "clean",
  "detail": "Passed both tiers.",
  "confidence": null,
  "stats": {
    "itemsStreamed": 3,
    "itemsDelivered": 3,
    "aborted": false,
    "upstreamRunId": "<realRunId>",
    "tokensDelivered": 3864,
    "tokensBlocked": 0,
    "usdSaved": 0
  },
  "data": [ { "title": "...", "address": "...", "...": "..." } ]
}
```

```bash
cat storage/key_value_stores/default/OUTPUT.json | jq .
```

(Token counts vary run-to-run — compass returns slightly different places each time.)

---

## Demo C — Real Tier 2 block (Gemini judge)

Make the intent and the scraper query disagree so Tier 2 rejects a real sample.

### Setup

1. In `.env`, set `GEMINI_API_KEY=...` (Google AI Studio).
2. In `storage/key_value_stores/default/INPUT.json`, keep the Georgian intent but
   point the query at something else:

```json
{
  "intent": "Georgian restaurants in Berlin, Germany",
  "actorId": "compass/crawler-google-places",
  "actorInput": { "searchStringsArray": ["sushi restaurants"], "locationQuery": "Berlin, Germany", "maxCrawledPlacesPerSearch": 3, "language": "en" },
  "requiredFields": ["title", "address"],
  "sampleSize": 3
}
```

### Run

```bash
npm run dev:real
```

**Expected** — the judge sees sushi data against a Georgian intent and blocks:

```json
{
  "ok": false,
  "tier": "tier2",
  "reason": "semantic_mismatch",
  "detail": "Judge: ... contains sushi restaurants ... not aligned with the intent.",
  "confidence": 0.95,
  "stats": { "itemsStreamed": 3, "itemsDelivered": 0, "aborted": true, "upstreamRunId": "<realRunId>", "tokensDelivered": 0, "tokensBlocked": 1200, "usdSaved": 0.0036 },
  "data": []
}
```

> Without `GEMINI_API_KEY` this specific case PASSES — the keyword heuristic shares
> vocabulary ("berlin", "restaurants") and can't tell sushi ≠ Georgian. That gap
> is exactly why the LLM judge exists. (See the heuristic note below.)

---

## Notes

- **No `GEMINI_API_KEY`?** Tier 2 uses the keyword heuristic (negation + vocab
  overlap + an injection regex). It never fails open — on any LLM error it also
  drops to the heuristic.
- **Cost fields** (`tokensDelivered` / `tokensBlocked` / `usdSaved`) are computed
  by the firewall and returned in OUTPUT; tokens are estimated from payload size
  (~4 chars/token), $ priced via the `downstreamUsdPerMTok` input (default 3).
- **Tunable inputs:** `extraBlocklist`, `confidenceThreshold`, `maxWaitSecs`,
  `downstreamUsdPerMTok` — see [.actor/input_schema.json](.actor/input_schema.json).
- **Local storage** lives in `storage/` (gitignored). `apify run -p` purges it
  between runs.
```
