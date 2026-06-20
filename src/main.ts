import { Actor } from 'apify';
import { ApifyClient } from 'apify-client';
import { runFirewall, type FirewallClient, type FirewallInput } from './firewall/run.js';

interface Input extends FirewallInput {
  geminiApiKey?: string;
}

await Actor.init();

const input = await Actor.getInput<Input>();
if (!input?.intent || !input?.actorId || !input?.actorInput) {
  throw new Error('Required input fields: intent, actorId, actorInput');
}

// Surface Gemini key to env so llm.ts can find it
if (input.geminiApiKey) process.env.GEMINI_API_KEY = input.geminiApiKey;

const client = new ApifyClient({ token: Actor.getEnv().token ?? process.env.APIFY_TOKEN });

const output = await runFirewall(client as unknown as FirewallClient, input, (m) => console.log(m));

await Actor.setValue('OUTPUT', output);

console.log(
  `Done. verdict=${output.ok ? 'PASS' : 'BLOCK'} delivered=${output.stats.itemsDelivered}/${output.stats.itemsStreamed} items`,
);

await Actor.exit();
