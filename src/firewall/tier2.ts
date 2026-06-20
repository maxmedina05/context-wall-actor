import { judgeSemantic } from '../llm.js';
import { block, pass, type Verdict } from './verdict.js';

export async function judgeSample(
  intent: string,
  sample: unknown[],
  signal?: AbortSignal,
): Promise<Verdict> {
  if (sample.length === 0) return pass();

  let v;
  try {
    v = process.env.GEMINI_API_KEY
      ? await judgeSemantic(intent, sample, signal)
      : heuristic(intent, sample);
  } catch (err) {
    if (signal?.aborted) return pass();
    // Degrade to heuristic on LLM error — never fail open.
    v = heuristic(intent, sample);
  }

  if (v.containsInjection) {
    return block('tier2', 'prompt_injection', `Judge: ${v.reason}`, { confidence: v.confidence });
  }
  if (v.isBlockPage) {
    return block('tier2', 'semantic_block', `Judge: ${v.reason}`, { confidence: v.confidence });
  }
  if (!v.aligned) {
    return block('tier2', 'semantic_mismatch', `Judge: ${v.reason}`, { confidence: v.confidence });
  }
  return pass();
}

const INJECTION_RX =
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|messages|context)|disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above)|system\s*(prompt|message)|new\s+instructions?\s*:|you\s+are\s+now\s+(a|an|the)\b|override\s+(your|the|all)\s+(instructions|rules|guardrails)/i;

function heuristic(intent: string, sample: unknown[]) {
  const raw = JSON.stringify(sample);
  if (INJECTION_RX.test(raw)) {
    return { aligned: false, isBlockPage: false, containsInjection: true, confidence: 0.8, reason: 'Sample contains instruction-like text targeting the agent (heuristic).' };
  }

  const blob = raw.toLowerCase();
  const words = intent
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['with', 'without', 'that', 'have'].includes(w));

  for (const kw of words) {
    const negated =
      new RegExp(`(no|without|not)\\s+${kw}`).test(blob) ||
      new RegExp(`"${kw}"\\s*:\\s*false`).test(blob);
    if (negated) {
      return { aligned: false, isBlockPage: false, containsInjection: false, confidence: 0.7, reason: `Sample negates requested feature "${kw}" (heuristic).` };
    }
  }

  const hits = words.filter((w) => blob.includes(w)).length;
  const ratio = words.length ? hits / words.length : 1;
  if (ratio < 0.34) {
    return { aligned: false, isBlockPage: false, containsInjection: false, confidence: 0.55, reason: 'Sample shares little vocabulary with intent (heuristic).' };
  }
  return { aligned: true, isBlockPage: false, containsInjection: false, confidence: 0.5, reason: 'Heuristic overlap acceptable.' };
}
