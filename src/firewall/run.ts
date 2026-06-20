import { checkItem } from './tier1.js';
import { judgeSample } from './tier2.js';
import { pass, type Verdict } from './verdict.js';

export interface FirewallInput {
  intent: string;
  actorId: string;
  actorInput: Record<string, unknown>;
  requiredFields?: string[];
  sampleSize?: number;
  /** Extra caller-supplied block-page phrases (Tier 1, matched case-insensitively). */
  extraBlocklist?: string[];
  /** Downstream LLM price used to estimate $ saved by blocking toxic tokens. Default 3 ($/1M tokens). */
  downstreamUsdPerMTok?: number;
  /** Min Tier 2 confidence to hard-block an intent mismatch. 0 = strictest (default). */
  confidenceThreshold?: number;
  /** Safety cap on total wait for the upstream run before failing closed. Default 300s. */
  maxWaitSecs?: number;
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
    /** Estimated tokens of clean data returned to the agent (0 when blocked). */
    tokensDelivered: number;
    /** Estimated tokens kept OUT of the agent's context by blocking. */
    tokensBlocked: number;
    /** Estimated downstream LLM $ saved by not ingesting the blocked tokens. */
    usdSaved: number;
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

const byteLen = (v: unknown): number => {
  try { return Buffer.byteLength(JSON.stringify(v) ?? ''); } catch { return 0; }
};
// ~4 chars per token is the standard rough estimate.
const estTokens = (bytes: number): number => Math.ceil(bytes / 4);

const errorVerdict = (detail: string): Verdict => ({
  ok: false, tier: null, reason: 'upstream_error', detail,
});

export async function runFirewall(
  client: FirewallClient,
  input: FirewallInput,
  log: Logger = () => {},
  pollIntervalMs = 750,
): Promise<FirewallOutput> {
  const {
    intent, actorId, actorInput,
    requiredFields = [], sampleSize = 3,
    extraBlocklist = [], downstreamUsdPerMTok = 3, confidenceThreshold = 0,
    maxWaitSecs = 300,
  } = input;

  const controller = new AbortController();
  const { signal } = controller;

  let verdict: Verdict = pass();
  const delivered: Record<string, unknown>[] = [];
  const sample: unknown[] = [];
  let itemsStreamed = 0;
  let abortStarted = false;
  let judgePromise: Promise<void> | null = null;
  let runId = '';
  let deliveredBytes = 0;   // bytes buffered as deliverable (withheld on a block)
  let blockedItemBytes = 0; // bytes of a Tier-1 toxic item (never added to delivered)

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

  try {
    log(`Starting target actor: ${actorId}`);
    const run = await client.actor(actorId).start(actorInput);
    runId = run.id;
    const datasetId = run.defaultDatasetId;
    log(`Upstream run started: ${runId}`);

    const deadline = Date.now() + maxWaitSecs * 1000;
    let offset = 0;

    outer: while (!signal.aborted) {
      const page = await client.dataset(datasetId).listItems({ offset, limit: 50, clean: true });

      for (const item of page.items) {
        if (signal.aborted) break outer;
        itemsStreamed++;

        // Tier 1: mechanical, per-item, ~ms
        const t1 = checkItem(item, itemsStreamed - 1, { requiredFields, extraBlocklist });
        if (!t1.ok) {
          verdict = t1;
          blockedItemBytes = byteLen(item);
          log(`[Tier 1 BLOCK] item #${itemsStreamed - 1}: ${t1.detail}`);
          await tripBreaker(`tier1:${t1.reason}`);
          break outer;
        }

        delivered.push(item as Record<string, unknown>);
        deliveredBytes += byteLen(item);

        // Buffer sample for Tier 2
        if (sample.length < sampleSize) sample.push(item);
        if (sample.length === sampleSize && !judgePromise) {
          log(`[Tier 2] judging ${sampleSize}-item sample...`);
          judgePromise = judgeSample(intent, sample.slice(), signal, { confidenceThreshold }).then(async (t2) => {
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

      // Fail closed if the upstream never settles within the cap.
      if (Date.now() > deadline && !signal.aborted) {
        verdict = errorVerdict(`Timed out after ${maxWaitSecs}s waiting for upstream run ${runId}.`);
        log(`[TIMEOUT] ${verdict.detail}`);
        await tripBreaker('timeout');
        break;
      }

      if (!finished && !signal.aborted) await sleep(pollIntervalMs, signal);
    }

    if (judgePromise) await judgePromise;
  } catch (err) {
    // Any failure (target actor won't start, paging error, etc.) fails CLOSED:
    // the agent still gets a verdict, never a crash with no OUTPUT.
    const msg = err instanceof Error ? err.message : String(err);
    verdict = errorVerdict(`Firewall error: ${msg}`);
    log(`[ERROR] ${msg}`);
    try { if (runId) await client.run(runId).abort(); } catch { /* ignore */ }
  }

  const data = verdict.ok ? delivered : [];
  const tokensDelivered = verdict.ok ? estTokens(deliveredBytes) : 0;
  const tokensBlocked = verdict.ok ? 0 : estTokens(deliveredBytes + blockedItemBytes);
  const usdSaved = Number(((tokensBlocked / 1_000_000) * downstreamUsdPerMTok).toFixed(6));

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
      tokensDelivered,
      tokensBlocked,
      usdSaved,
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
