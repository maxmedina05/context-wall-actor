import { block, pass, type Verdict } from './verdict.js';

const BLOCKLIST: RegExp[] = [
  /cloudflare/i,
  /access\s+denied/i,
  /captcha/i,
  /are\s+you\s+(a\s+)?human/i,
  /please\s+(log|sign)\s*in/i,
  /enable\s+javascript/i,
  /verify\s+you\s+are\s+(a\s+)?human/i,
  /rate\s*limit|too\s+many\s+requests/i,
  /attention\s+required/i,
  /just\s+a\s+moment/i,
  /\b40[13]\b.*forbidden|forbidden.*\b40[13]\b/i,
  /bot\s+detection|automated\s+traffic/i,
  // Modern anti-bot / WAF block pages — often served at HTTP 200 with valid JSON shape.
  /powered\s+(and|&)\s+protected\s+by/i, // Akamai bot manager
  /you\s+have\s+been\s+blocked/i,
  /\bray\s*id\b/i, // Cloudflare incident id
  /checking\s+your\s+browser/i, // Cloudflare interstitial
  /pardon\s+our\s+interruption/i, // Distil / Imperva
  /\bperimeterx\b|press\s+(and|&)\s+hold/i, // PerimeterX
  /\bdatadome\b/i,
  /\bincapsula\b/i, // Imperva
  /unusual\s+(traffic|activity)/i, // Google / generic
  /suspicious\s+activity\s+(detected|from)/i,
  /security\s+check(\s+required)?/i,
  /complete\s+the\s+(security\s+)?(check|challenge)/i,
  /your\s+request\s+(has\s+been\s+)?(blocked|denied)/i,
  /service\s+(temporarily\s+)?unavailable/i,
  /\brobot\s+(check|verification)\b/i,
  /request\s+(unsuccessful|could\s+not\s+be\s+(processed|completed))/i,
];

// Prompt-injection signatures embedded in scraped content (reviews, descriptions,
// names…). Kept tight to avoid false positives on real business data.
const INJECTION: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|messages|context)/i,
  /disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)/i,
  /\bsystem\s*(prompt|message)\b/i,
  /\bnew\s+instructions?\s*:/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /<\|?(im_start|im_end|system|endoftext)\|?>/i,
  /\b(begin|end)\s+system\s+prompt\b/i,
  /\boverride\s+(your|the|all)\s+(instructions|rules|guardrails)/i,
];

export interface Tier1Options {
  requiredFields?: string[];
  /** Extra caller-supplied block-page phrases (matched case-insensitively). */
  extraBlocklist?: string[];
}

function compileExtra(phrases?: string[]): RegExp[] {
  if (!phrases?.length) return [];
  return phrases
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      try {
        return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

function flatten(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function checkItem(item: unknown, index: number, opts: Tier1Options = {}): Verdict {
  const blob = flatten(item);

  if (blob.trim().length === 0 || blob === '{}' || blob === '[]') {
    return block('tier1', 'empty', `Item #${index} is empty.`, { atItem: index });
  }

  for (const rx of [...BLOCKLIST, ...compileExtra(opts.extraBlocklist)]) {
    const m = blob.match(rx);
    if (m) {
      return block('tier1', 'blocklist_keyword', `Item #${index} contains block-page signal: "${m[0]}".`, { atItem: index });
    }
  }

  for (const rx of INJECTION) {
    const m = blob.match(rx);
    if (m) {
      return block('tier1', 'prompt_injection', `Item #${index} contains a prompt-injection signal: "${m[0]}".`, { atItem: index });
    }
  }

  if (opts.requiredFields?.length && item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    for (const f of opts.requiredFields) {
      const v = obj[f];
      if (v == null || (typeof v === 'string' && v.trim() === '')) {
        return block('tier1', 'schema_invalid', `Item #${index} missing required field "${f}".`, { atItem: index });
      }
    }
  }

  return pass();
}
