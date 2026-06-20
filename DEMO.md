# ContextWall Firewall — Demo Walkthrough

Three demos, cheapest/most-deterministic first. Copy the commands, compare your
output to the **Expected output** blocks.

| Demo | What it proves | Needs cloud? | Needs keys? |
|------|----------------|--------------|-------------|
| A — Offline (fake client) | Tier 1 + Tier 2 + early abort, all 3 scenarios | No | No |
| B — Real cloud, clean path | Firewall really starts/polls/aborts a live Apify actor | Yes | `APIFY_TOKEN` |
| C — Real Tier 2 (LLM) | Gemini semantic judge fires on a real sample | Yes | `APIFY_TOKEN` + `GEMINI_API_KEY` |

---

## Demo A — Offline, deterministic (start here)

No token, no credits, no network. A fake Apify client streams three fixtures
row-by-row and honours abort like the real cloud.

```bash
npm install
npm run test:local
```

**Expected output:**

```
================ scenario: clean ================
  Starting target actor: fake/mock-actor
  Upstream run started: fake-run-1
  [Tier 2] judging 3-item sample...
  [Tier 2] verdict: PASS — Passed both tiers.
  RESULT ok=true tier=null reason=clean delivered=12/12 aborted=false
  ✅ PASS

================ scenario: hard ================
  Starting target actor: fake/mock-actor
  Upstream run started: fake-run-1
  [Tier 1 BLOCK] item #0: Item #0 contains block-page signal: "Cloudflare".
  Aborted upstream run fake-run-1 — tier1:blocklist_keyword
  RESULT ok=false tier=tier1 reason=blocklist_keyword delivered=0/1 aborted=true
  ✅ PASS

================ scenario: soft ================
  Starting target actor: fake/mock-actor
  Upstream run started: fake-run-1
  [Tier 2] judging 3-item sample...
  [Tier 2] verdict: BLOCK — Judge: Sample negates requested feature "delivery" (heuristic).
  Aborted upstream run fake-run-1 — tier2:semantic_mismatch
  RESULT ok=false tier=tier2 reason=semantic_mismatch delivered=0/3 aborted=true
  ✅ PASS

✅ ALL SCENARIOS PASSED
```

**Read it:**
- **clean** — 12 valid rows, both tiers pass, all 12 delivered, no abort.
- **hard** — perfectly-shaped JSON whose *values* are Cloudflare block-page text.
  Tier 1 catches it at item #0 → upstream aborted after only **1 of 12** rows
  streamed → 0 delivered. (A naive schema check would have waved this through.)
- **soft** — valid restaurant data but `"delivery": false` — the opposite of the
  intent. Tier 2 (heuristic here, no Gemini key) blocks after the 3-item sample →
  aborted at **3 of 12** → 0 delivered.

The `streamed < 12` + `aborted=true` on both blocks is the whole point: the
breaker trips **before** the upstream finishes, so you stop paying and nothing
toxic reaches the agent.

---

## Demo B — Real Apify cloud, clean path

Runs the firewall **locally** but it starts and polls a **real** scraper actor on
Apify cloud. The firewall itself does NOT need to be deployed for this.

> Costs a few Apify credits (real scraper run). `maxCrawledPlaces: 3` keeps it tiny.

### Setup

```bash
cp .env.example .env          # then edit .env, set APIFY_TOKEN=apify_api_...
cp INPUT.example.json storage/key_value_stores/default/INPUT.json   # already present; re-copy to reset
```

The input ([INPUT.example.json](INPUT.example.json)) targets `compass/crawler-google-places` (the real Apify Google Maps scraper):

```json
{
  "intent": "Georgian restaurants in Berlin, Germany",
  "actorId": "compass/crawler-google-places",
  "actorInput": { "searchStringsArray": ["Georgian restaurants"], "locationQuery": "Berlin, Germany", "maxCrawledPlacesPerSearch": 3, "language": "en" },
  "requiredFields": ["title", "address"],
  "sampleSize": 10
}
```

`sampleSize: 10` is intentional — only 3 items come back, so the sample never
fills to 10 and **Tier 2 never fires**. This isolates the clean plumbing path
(start → poll → Tier 1 → deliver → OUTPUT) with no LLM in the way.

### Run

```bash
npm run dev:real      # tsx --env-file=.env src/main.ts
# or, equivalently, via the Apify CLI:
apify run
```

**Expected console (abridged):**

```
Starting target actor: apify/google-maps-scraper
Upstream run started: <realRunId>
Done. verdict=PASS delivered=3/3 items
```

**Expected result file** — `storage/key_value_stores/default/OUTPUT.json`:

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
    "upstreamRunId": "<realRunId>"
  },
  "data": [
    { "title": "...", "address": "...", "...": "..." }
  ]
}
```

Inspect it:

```bash
cat storage/key_value_stores/default/OUTPUT.json | jq .
```

When called through the Apify MCP server (after deploy), the agent receives this
exact object as the tool response — verdict + clean `data` in one shot.

---

## Demo C — Real Tier 2 (Gemini semantic judge)

Same as B, but turn Tier 2 on so the LLM actually judges the sample.

### Setup

1. In `.env`, set `GEMINI_API_KEY=...` (Google AI Studio).
2. In `storage/key_value_stores/default/INPUT.json`, set `"sampleSize": 3` so the
   judge fires after 3 items.

### Run

```bash
npm run dev:real
```

**Expected console (abridged):**

```
Starting target actor: apify/google-maps-scraper
Upstream run started: <realRunId>
[Tier 2] judging 3-item sample...
[Tier 2] verdict: PASS — Passed both tiers.
Done. verdict=PASS delivered=3/3 items
```

To see Tier 2 **block** for real, make the `intent` and the scraper query
disagree — keep `intent: "Georgian restaurants in Berlin, Germany"` but set
`searchStringsArray: ["sushi restaurants"]`. The judge sees a Japanese-food
sample that doesn't satisfy a Georgian-food intent and blocks it. Expected:

```json
{
  "ok": false,
  "tier": "tier2",
  "reason": "semantic_mismatch",
  "detail": "Judge: <model's reason>",
  "confidence": 0.0,
  "stats": { "itemsStreamed": 3, "itemsDelivered": 0, "aborted": true, "upstreamRunId": "<realRunId>" },
  "data": []
}
```

---

## Notes

- **No `GEMINI_API_KEY`?** Tier 2 silently uses the keyword heuristic (negation +
  vocab-overlap). It never fails open — on any LLM error it also drops to the
  heuristic.
- **Deterministic block scenarios on real cloud** would require a mock actor
  deployed to Apify that emits the `hard`/`soft` fixtures; the in-repo fixtures
  (Demo A) cover that without spending credits.
- **Local storage** lives in `storage/` (gitignored). `apify run -p` purges it
  between runs.
