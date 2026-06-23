// Aura reading + auric-resonance scoring.
// If ANTHROPIC_API_KEY is set, the reading comes from Claude vision; otherwise a
// deterministic local "mock" reading is generated so the app is fully usable offline.
const crypto = require('crypto');

const ENERGY_KEYS = ['warmth', 'openness', 'intensity', 'groundedness', 'playfulness', 'depth', 'spark'];
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// Seven chakras (with classical colors) and five elements.
const CHAKRAS = [
  { key: 'root',     name: 'Root',         sanskrit: 'Muladhara',    color: '#e53935' },
  { key: 'sacral',   name: 'Sacral',       sanskrit: 'Svadhisthana', color: '#fb8c00' },
  { key: 'solar',    name: 'Solar Plexus', sanskrit: 'Manipura',     color: '#fdd835' },
  { key: 'heart',    name: 'Heart',        sanskrit: 'Anahata',      color: '#43a047' },
  { key: 'throat',   name: 'Throat',       sanskrit: 'Vishuddha',    color: '#1e88e5' },
  { key: 'thirdEye', name: 'Third Eye',    sanskrit: 'Ajna',         color: '#3949ab' },
  { key: 'crown',    name: 'Crown',        sanskrit: 'Sahasrara',    color: '#8e24aa' }
];
const ELEMENTS = [
  { key: 'fire',  name: 'Fire',  glyph: '🔥' },
  { key: 'water', name: 'Water', glyph: '💧' },
  { key: 'air',   name: 'Air',   glyph: '🌬️' },
  { key: 'earth', name: 'Earth', glyph: '⛰️' },
  { key: 'space', name: 'Space', glyph: '✦' }
];

const AURA_PALETTES = [
  { name: 'The Luminous Empath', colors: ['#7C4DFF', '#FF6FB5'] },
  { name: 'The Quiet Flame', colors: ['#FF7043', '#FFCA28'] },
  { name: 'The Deep Current', colors: ['#26C6DA', '#5C6BC0'] },
  { name: 'The Wild Spark', colors: ['#FF4081', '#FFD740'] },
  { name: 'The Grounded Oak', colors: ['#66BB6A', '#8D6E63'] },
  { name: 'The Dreaming Tide', colors: ['#42A5F5', '#AB47BC'] },
  { name: 'The Radiant Host', colors: ['#FFA726', '#EC407A'] },
  { name: 'The Still Lake', colors: ['#26A69A', '#78909C'] },
  { name: 'The Aurora Mind', colors: ['#00E5FF', '#B388FF'] },
  { name: 'The Velvet Storm', colors: ['#7E57C2', '#26C6DA'] }
];
const TRAIT_POOL = ['curious','warm','magnetic','introspective','playful','loyal','adventurous','gentle','intense','witty','grounded','imaginative','nurturing','bold','thoughtful','spontaneous','calm','expressive','independent','devoted'];

function bytesFrom(str) { return Array.from(crypto.createHash('sha256').update(String(str)).digest()); }
function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }
function num(v, def) { return (typeof v === 'number' && isFinite(v)) ? clamp(v) : def; }
function pick(arr, n) { return arr[n % arr.length]; }

// Deterministic chakra + element profile from any seed string.
function profileExtras(seedStr) {
  const a = bytesFrom(seedStr + '|chakra');
  const b = bytesFrom(seedStr + '|element');
  const chakras = CHAKRAS.map((c, i) => ({ ...c, development: 32 + (a[i] % 64), vibrancy: 32 + (a[i + 7] % 64) }));
  const elements = ELEMENTS.map((e, i) => ({ ...e, mastery: 32 + (b[i] % 64), balance: 32 + (b[i + 5] % 64) }));
  return { chakras, elements };
}

// Coerce/fill chakras + elements onto a reading (used for Claude output too).
function ensureExtras(reading, seedStr) {
  const base = profileExtras(seedStr);
  let chakras = base.chakras;
  if (Array.isArray(reading.chakras)) {
    chakras = CHAKRAS.map((c, i) => {
      const got = reading.chakras.find(x => x && (x.key === c.key ||
        (typeof x.name === 'string' && x.name.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]))));
      return { ...c, development: num(got && got.development, base.chakras[i].development), vibrancy: num(got && got.vibrancy, base.chakras[i].vibrancy) };
    });
  }
  let elements = base.elements;
  if (reading.elements && typeof reading.elements === 'object') {
    elements = ELEMENTS.map((e, i) => {
      const got = reading.elements[e.key] || reading.elements[e.name] || reading.elements[e.name.toLowerCase()];
      return { ...e, mastery: num(got && got.mastery, base.elements[i].mastery), balance: num(got && got.balance, base.elements[i].balance) };
    });
  }
  reading.chakras = chakras;
  reading.elements = elements;
  return reading;
}

function mockReading(buffer) {
  const h = bytesFrom(buffer.toString('base64').slice(0, 64));
  const palette = pick(AURA_PALETTES, h[0]);
  const energy = {};
  ENERGY_KEYS.forEach((k, i) => { energy[k] = 35 + (h[i + 1] % 60); });
  const traits = [];
  for (let i = 0; i < 5; i++) { const t = pick(TRAIT_POOL, h[i + 9] + i * 7); if (!traits.includes(t)) traits.push(t); }
  const reading = {
    auraName: palette.name,
    auraColors: palette.colors,
    headline: `${traits[0][0].toUpperCase() + traits[0].slice(1)} energy with a ${traits[1]} undertone`,
    summary: `Your aura reads as ${traits[0]} and ${traits[1]} — a steady glow that draws people in. You lead with ${traits[2]} warmth and meet the world with a ${traits[3]} curiosity.`,
    temperament: `${energy.intensity > 60 ? 'Fiery and expressive' : 'Calm and steady'}, with a ${energy.depth > 60 ? 'deep, reflective' : 'light, easy'} core.`,
    personality: traits,
    strengths: [traits[0], traits[2], traits[4]],
    loveStyle: energy.warmth > 60 ? 'You love openly and generously, and you make people feel chosen.' : 'You love thoughtfully and steadily, building trust before you fully open up.',
    vibe: `${palette.colors[0]} meets ${palette.colors[1]}`,
    energy,
    _source: 'mock'
  };
  return ensureExtras(reading, buffer.toString('base64').slice(0, 96));
}

function extractJson(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text;
  return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
}

const PROMPT = `You are the aura-reading engine for "Auritech Mesh", a playful aura-scanner dating app.
Look at this person's selfie and produce a warm, flattering, specific "aura reading" for their dating profile.

IMPORTANT framing rules:
- This is entertainment and self-expression, NOT a clinical or psychological assessment.
- Be kind and positive. Never diagnose mental health, never mention illness, never say anything negative or about their physical attractiveness/race/age.
- Read "vibe", "energy", chakras and elements as imaginative self-expression, not medical or factual claims.

Return ONLY a JSON object with exactly these fields:
{
  "auraName": "a short evocative archetype, e.g. 'The Luminous Empath'",
  "auraColors": ["#hex", "#hex"],
  "headline": "one short poetic line for their profile",
  "summary": "2-3 warm sentences reading their aura",
  "temperament": "one sentence",
  "personality": ["trait","trait","trait","trait","trait"],
  "strengths": ["strength","strength","strength"],
  "loveStyle": "one warm sentence about how they connect in love",
  "vibe": "a short phrase",
  "energy": { "warmth":0-100, "openness":0-100, "intensity":0-100, "groundedness":0-100, "playfulness":0-100, "depth":0-100, "spark":0-100 },
  "chakras": [
    {"key":"root","development":0-100,"vibrancy":0-100},
    {"key":"sacral","development":0-100,"vibrancy":0-100},
    {"key":"solar","development":0-100,"vibrancy":0-100},
    {"key":"heart","development":0-100,"vibrancy":0-100},
    {"key":"throat","development":0-100,"vibrancy":0-100},
    {"key":"thirdEye","development":0-100,"vibrancy":0-100},
    {"key":"crown","development":0-100,"vibrancy":0-100}
  ],
  "elements": {
    "fire":{"mastery":0-100,"balance":0-100},
    "water":{"mastery":0-100,"balance":0-100},
    "air":{"mastery":0-100,"balance":0-100},
    "earth":{"mastery":0-100,"balance":0-100},
    "space":{"mastery":0-100,"balance":0-100}
  }
}
development = how awakened/cultivated that chakra reads; vibrancy = how brightly it is glowing right now.
mastery = command of that element's qualities; balance = how harmonized it is with the rest.`;

async function generateReading(buffer, mediaType = 'image/jpeg') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return mockReading(buffer);
  const seed = buffer.toString('base64').slice(0, 96);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1200,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
          { type: 'text', text: PROMPT }
        ] }]
      })
    });
    if (!resp.ok) throw new Error('anthropic ' + resp.status);
    const data = await resp.json();
    const reading = extractJson((data.content || []).map(c => c.text || '').join(''));
    reading.energy = reading.energy || {};
    ENERGY_KEYS.forEach(k => { if (typeof reading.energy[k] !== 'number') reading.energy[k] = 50; });
    reading.auraColors = (reading.auraColors && reading.auraColors.length) ? reading.auraColors.slice(0, 2) : ['#7C4DFF', '#FF6FB5'];
    reading._source = 'claude';
    return ensureExtras(reading, seed);
  } catch (e) {
    console.error('aura reading fell back to mock:', e.message);
    return mockReading(buffer);
  }
}

function resonance(a, b) {
  if (!a || !b) return 0;
  const sim = (k) => 1 - Math.abs((a[k] ?? 50) - (b[k] ?? 50)) / 100;
  const comp = (k) => 1 - Math.abs(100 - ((a[k] ?? 50) + (b[k] ?? 50))) / 100;
  const similarity = (sim('warmth') + sim('depth') + sim('openness') + sim('groundedness')) / 4;
  const complement = (comp('intensity') + comp('playfulness') + comp('spark')) / 3;
  return Math.max(38, Math.min(99, Math.round(100 * (0.62 * similarity + 0.38 * complement))));
}

module.exports = { generateReading, mockReading, resonance, profileExtras, ENERGY_KEYS, CHAKRAS, ELEMENTS };
