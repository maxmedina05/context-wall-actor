export type Tier = 'tier1' | 'tier2';

export type Reason =
  | 'clean'
  | 'blocklist_keyword'
  | 'schema_invalid'
  | 'empty'
  | 'semantic_mismatch'
  | 'semantic_block'
  | 'prompt_injection';

export interface Verdict {
  ok: boolean;
  tier: Tier | null;
  reason: Reason;
  detail: string;
  atItem?: number;
  confidence?: number;
}

export const pass = (): Verdict => ({ ok: true, tier: null, reason: 'clean', detail: 'Passed both tiers.' });

export const block = (
  tier: Tier,
  reason: Reason,
  detail: string,
  extra: Partial<Verdict> = {},
): Verdict => ({ ok: false, tier, reason, detail, ...extra });
