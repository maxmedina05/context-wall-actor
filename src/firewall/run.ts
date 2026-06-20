import { checkItem } from './tier1.js';
import { judgeSample } from './tier2.js';
import { pass, type Verdict } from './verdict.js';

export interface FirewallInput {
  intent: string;
  actorId: string;
  actorInput: Record<string, unknown>;
  requiredFields?: string[];
  sampleSize?: number;
}

export interface FirewallOutput {
  ok: boolean;
  tier: Verdict['tier'];
  reason: Verdict['reason'];
  detail: string;
  confidence: number | null;
  stats: {
    itemsStreamed: number;
    itemsDelivered: number;
    aborted: boolean;
    upstreamRunId: string;
  };
  data: Record<string, unknown>[];
}

/**
 * Minimal structural slice of apify-client used by the firewall. Both the real
 * ApifyClient and the local fake satisfy this — keeps the poll loop testable
 * without touching Apify cloud.
 */
export interface FirewallClient {
  actor(actorId: string): {
    start(input: Record<string, unknown>): Promise<{ id: string; defaultDatasetId: string }>;
  };
  run(runId: string): {
    get(): Promise<{ status?: string } | undefined>;
    abort(): Promise<unknown>;
  };
  dataset(datasetId: string): {
    listItems(opts: { offset: number; limit: number; clean: boolean }): Promise<{
      items: unknown[];
      total?: number;
    }>;
  };
}

type Logger = (msg: string) => void;

export async function runFirewall(
  client: FirewallClient,
  input: FirewallInput,
  log: Logger = () => {},
  pollIntervalMs = 750,
): Promise<FirewallOutput> {
  const { intent, actorId, actorInput, requiredFields = [], sampleSize = 3 } = input;

  log(`Starting target actor: ${actorId}`);
  const run = await client.actor(actorId).start(actorInput);
  const { id: runId, defaultDatasetId: datasetId } = run;
  log(`Upstream run started: ${runId}`);

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
      log(`Aborted upstream run ${runId} — ${reason}`);
    } catch {
      /* already finished */
    }
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
        log(`[Tier 1 BLOCK] item #${itemsStreamed - 1}: ${t1.detail}`);
        await tripBreaker(`tier1:${t1.reason}`);
        break outer;
      }

      delivered.push(item as Record<string, unknown>);

      // Buffer sample for Tier 2
      if (sample.length < sampleSize) sample.push(item);
      if (sample.length === sampleSize && !judgePromise) {
        log(`[Tier 2] judging ${sampleSize}-item sample...`);
        judgePromise = judgeSample(intent, sample.slice(), signal).then(async (t2) => {
          log(`[Tier 2] verdict: ${t2.ok ? 'PASS' : 'BLOCK'} — ${t2.detail}`);
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
    if (!finished && !signal.aborted) await sleep(pollIntervalMs, signal);
  }

  if (judgePromise) await judgePromise;

  const data = verdict.ok ? delivered : [];

  return {
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
    data,
  };
}

function sleep(ms: number, sig: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (sig.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    sig.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
