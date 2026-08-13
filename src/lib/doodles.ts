/** Bundled sim doodles from GWCA-CLI (`public/personas`, `public/scenarios`). */

export const DOODLE_COUNT = 50;
export const SCENE_COUNT = 40;

export function doodleSrc(index: number): string {
  const wrapped = ((index % DOODLE_COUNT) + DOODLE_COUNT) % DOODLE_COUNT;
  return `/personas/doodle-${String(wrapped + 1).padStart(2, '0')}.jpg`;
}

export function sceneSrc(index: number): string {
  const wrapped = ((index % SCENE_COUNT) + SCENE_COUNT) % SCENE_COUNT;
  return `/scenarios/scene-${String(wrapped + 1).padStart(2, '0')}.jpg`;
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const FEMALE_DOODLES = [
  4, 7, 9, 13, 14, 17, 33, 34, 35, 36, 39, 40, 42, 43, 44, 45, 48, 49,
] as const;
const FEMALE_SET = new Set<number>(FEMALE_DOODLES);
const MALE_DOODLES = Array.from({ length: DOODLE_COUNT }, (_, i) => i).filter(
  i => !FEMALE_SET.has(i)
);

const FEMALE_NAMES = new Set([
  'elizabeth', 'aroha', 'sarah', 'sara', 'emma', 'olivia', 'sophia', 'sophie',
  'isabella', 'mia', 'amelia', 'emily', 'harper', 'evelyn', 'abigail', 'ella',
  'elena', 'grace', 'chloe', 'victoria', 'lily', 'hannah', 'natalie', 'zoe',
  'anna', 'mary', 'linda', 'patricia', 'jennifer', 'jessica', 'susan', 'karen',
]);
const MALE_NAMES = new Set([
  'john', 'david', 'samuel', 'james', 'robert', 'michael', 'william', 'bharat',
  'richard', 'joseph', 'thomas', 'charles', 'daniel', 'matthew', 'marcus',
  'mark', 'paul', 'andrew', 'joshua', 'kevin', 'brian', 'george', 'edward',
  'ryan', 'nicholas', 'eric', 'jacob', 'frank', 'oliver', 'liam', 'noah',
]);

type Gender = 'male' | 'female' | 'neutral';

function predictGender(name?: string): Gender {
  const tokens = (name || '').trim().split(/[\s\-—_]+/);
  const first = (tokens.find(t => /[a-z]/i.test(t)) || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (FEMALE_NAMES.has(first)) return 'female';
  if (MALE_NAMES.has(first)) return 'male';
  return 'neutral';
}

export function defaultDoodleIndex(name?: string): number {
  const g = predictGender(name);
  const bucket = g === 'male' ? MALE_DOODLES : g === 'female' ? [...FEMALE_DOODLES] : null;
  const h = hashString(name || '');
  if (bucket && bucket.length) return bucket[h % bucket.length];
  return h % DOODLE_COUNT;
}

/** Situation doodle from claim type / name — same keyword idea as GWCA-CLI sims. */
export function defaultSceneIndex(claimType: string, extra = ''): number {
  const hay = `${claimType} ${extra}`.toLowerCase();
  if (/\b(flood|water|pipe|burst|mold)\b/.test(hay)) return 16;
  if (/\b(homeowner|home|dwelling|property|basement)\b/.test(hay)) return 13;
  if (/\b(collision|crash|accident|auto|vehicle|debris)\b/.test(hay)) return 0;
  if (/\b(medical|prior|health|injur|authorization|orthopedic)\b/.test(hay)) return 2;
  return 11;
}
