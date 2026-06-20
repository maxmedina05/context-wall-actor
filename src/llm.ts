import { GoogleGenAI, Type } from '@google/genai';

export interface SemanticVerdict {
  aligned: boolean;
  isBlockPage: boolean;
  confidence: number;
  reason: string;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    aligned: { type: Type.BOOLEAN },
    isBlockPage: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    reason: { type: Type.STRING },
  },
  required: ['aligned', 'isBlockPage', 'confidence', 'reason'],
};

let client: GoogleGenAI | null = null;

export async function judgeSemantic(
  intent: string,
  sample: unknown[],
  _signal?: AbortSignal,
): Promise<SemanticVerdict> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  if (!client) client = new GoogleGenAI({ apiKey });

  const prompt = [
    `You are a data-quality firewall. An AI agent requested data with this intent:`,
    `INTENT: "${intent}"`,
    ``,
    `Here is a small sample of what the scraper returned (JSON):`,
    '```json',
    JSON.stringify(sample, null, 2).slice(0, 6000),
    '```',
    ``,
    `Decide:`,
    `- isBlockPage: true if this is an anti-bot / CAPTCHA / login / error page rather than real data.`,
    `- aligned: true ONLY if the data genuinely satisfies the agent's intent.`,
    `Be strict. When unsure, set the unsafe value (isBlockPage=true / aligned=false).`,
  ].join('\n');

  const res = await client.models.generateContent({
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite',
    contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
  });

  return JSON.parse(res.text ?? '{}') as SemanticVerdict;
}
