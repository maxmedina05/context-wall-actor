import { Actor } from 'apify';
import { ApifyClient } from 'apify-client';
import { checkItem } from './firewall/tier1.js';
import { judgeSample } from './firewall/tier2.js';
import { pass, type Verdict } from './firewall/verdict.js';

interface Input {
  intent: string;
  actorId: string;
  actorInput: Record<string, unknown>;
  requiredFields?: string[];
  sampleSize?: number;
  geminiApiKey?: string;
}

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input?.intent || !input?.actorId || !input?.actorInput) {
  throw new Error('Required input fields: intent, actorId, actorInput');
}

const { intent, actorId, actorInput, requiredFields = [], sampleSize = 3, geminiApiKey } = input;

// Surface Gemini key to env so llm.ts can find it
if (geminiApiKey) process.env.GEMINI_API_KEY = geminiApiKey;

const client = new ApifyClient({ token: Actor.getEnv().token ?? process.env.APIFY_TOKEN });

console.log(`Starting target actor: ${actorId}`);
const run = await client.actor(actorId).start(actorInput);
const { id: runId, defaultDatasetId: datasetId } = run;
console.log(`Upstream run started: ${runId}`);

const controller = new AbortController();
const { signal } = controller;

let verdict: Verdict = pass();
const delivered: Record<string, unknown>[] = [];
const sample: unknown[] = [];
let itemsStreamed = 0;
let abortStarted = false;
let judgePromise: Promise<void> | null = null;

const tripBreaker = async (reason: string) => {
  if (abortStarted) return;
  abortStarted = true;
  controller.abort(reason);
  try {
    await client.run(runId).abort();
    console.log(`Aborted upstream run ${runId} — ${reason}`);
  } catch { /* already finished */ }
};

// Poll dataset while upstream run is in progress — same pattern as the MCP version.
let offset = 0;

outer: while (!signal.aborted) {
  const page = await client.dataset(datasetId).listItems({ offset, limit: 50, clean: true });

  for (const item of page.items) {
    if (signal.aborted) break outer;
    itemsStreamed++;

    // Tier 1: mechanical, per-item, ~ms
    const t1 = checkItem(item, itemsStreamed - 1, { requiredFields });
    if (!t1.ok) {
      verdict = t1;
      console.log(`[Tier 1 BLOCK] item #${itemsStreamed - 1}: ${t1.detail}`);
      await tripBreaker(`tier1:${t1.reason}`);
      break outer;
    }

    delivered.push(item as Record<string, unknown>);

    // Buffer sample for Tier 2
    if (sample.length < sampleSize) sample.push(item);
    if (sample.length === sampleSize && !judgePromise) {
      console.log(`[Tier 2] judging ${sampleSize}-item sample...`);
      judgePromise = judgeSample(intent, sample.slice(), signal).then(async (t2) => {
        console.log(`[Tier 2] verdict: ${t2.ok ? 'PASS' : 'BLOCK'} — ${t2.detail}`);
        if (!t2.ok && !signal.aborted) {
          verdict = t2;
          await tripBreaker(`tier2:${t2.reason}`);
        }
      });
    }
  }

  offset += page.items.length;

  const runInfo = await client.run(runId).get();
  const status = runInfo?.status;
  const finished = status && status !== 'RUNNING' && status !== 'READY';
  if (finished && offset >= (page.total ?? 0)) break;
  if (!finished && !signal.aborted) await sleep(750, signal);
}

if (judgePromise) await judgePromise;

const data = verdict.ok ? delivered : [];

const output = {
  ok: verdict.ok,
  tier: verdict.tier,
  reason: verdict.reason,
  detail: verdict.detail,
  confidence: verdict.confidence ?? null,
  stats: {
    itemsStreamed,
    itemsDelivered: data.length,
    aborted: signal.aborted,
    upstreamRunId: runId,
  },
  // Inline data — agent gets everything in one response via Apify MCP
  data,
};

await Actor.setValue('OUTPUT', output);

console.log(`Done. verdict=${verdict.ok ? 'PASS' : 'BLOCK'} delivered=${data.length}/${itemsStreamed} items`);

await Actor.exit();

function sleep(ms: number, sig: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (sig.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    sig.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
