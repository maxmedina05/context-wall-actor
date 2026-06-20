import { Actor } from 'apify';

/**
 * A second, clean restaurant source for the multi-source demo. Returns valid,
 * on-intent Georgian-restaurant listings for Berlin — no block-page text, no
 * injection. The firewall should PASS this source.
 */

await Actor.init();

const { count = 3, delayMs = 150 } = (await Actor.getInput()) ?? {};

const ROWS = [
  { name: 'Tiflis', rating: 4.7, cuisine: 'Georgian', address: 'Lausitzer Pl 14, 10997 Berlin', topReview: 'Authentic khachapuri and warm service.' },
  { name: 'Suliko', rating: 4.5, cuisine: 'Georgian', address: 'Wexstr 2, 10825 Berlin', topReview: 'Generous portions, lovely wine list.' },
  { name: 'Schwiliko', rating: 4.6, cuisine: 'Georgian', address: 'Wühlischstr 49, 10245 Berlin', topReview: 'Cozy spot, the khinkali are excellent.' },
  { name: 'Georgisches Restaurant Mtatsminda', rating: 4.4, cuisine: 'Georgian', address: 'Pestalozzistr 75, 10627 Berlin', topReview: 'Hearty traditional dishes, friendly staff.' },
  { name: 'Chama', rating: 4.5, cuisine: 'Georgian', address: 'Kastanienallee 91, 10435 Berlin', topReview: 'Great supra-style sharing menu.' },
];

const n = Math.max(1, Math.min(Number(count) || 3, ROWS.length));
console.log(`berlin-dining-guide: returning ${n} listings`);

for (let i = 0; i < n; i++) {
  await Actor.pushData(ROWS[i]);
  await new Promise((r) => setTimeout(r, delayMs));
}

console.log('berlin-dining-guide: done');
await Actor.exit();
