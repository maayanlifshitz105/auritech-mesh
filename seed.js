// Seeds demo profiles so the discover deck feels alive on first run.
// Demo users have no password (can't log in); they auto-like back and auto-reply.
// Their portraits are AI-generated (Pollinations) and their auric profiles
// (chakras + elements) are produced by the same reading engine as real users.
const { profileExtras } = require('./aura');

function aiPhoto(look, seed) {
  const prompt = `soft natural-light portrait photo of ${look}, shallow depth of field, photorealistic, dating profile headshot`;
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=640&seed=${seed}&nologo=true&model=flux`;
}

const DEMOS = [
  { name: 'Maya', age: 28, gender: 'woman', seeking: 'man', bio: 'Ceramicist, ocean swimmer, always chasing golden hour.',
    look: 'a serene 28 year old woman with wavy brown hair, gentle smile, warm tones',
    reading: { auraName: 'The Dreaming Tide', auraColors: ['#42A5F5', '#AB47BC'], headline: 'Soft-spoken with a deep blue current',
      summary: 'Your aura runs deep and calm, like water that remembers everything. People feel safe in your presence.',
      personality: ['gentle','imaginative','loyal','introspective','warm'], energy: { warmth: 78, openness: 66, intensity: 40, groundedness: 72, playfulness: 55, depth: 88, spark: 50 } } },
  { name: 'Leo', age: 31, gender: 'man', seeking: 'woman', bio: 'Jazz drummer + terrible cook. Will make you laugh.',
    look: 'a charismatic 31 year old man with short dark hair and a warm grin, casual style',
    reading: { auraName: 'The Wild Spark', auraColors: ['#FF4081', '#FFD740'], headline: 'A grin that arrives before you do',
      summary: 'Your aura crackles. You bring color into rooms and people remember how alive they felt around you.',
      personality: ['playful','bold','witty','spontaneous','expressive'], energy: { warmth: 70, openness: 80, intensity: 75, groundedness: 45, playfulness: 92, depth: 48, spark: 88 } } },
  { name: 'Aria', age: 26, gender: 'woman', seeking: 'man', bio: 'PhD by day, rock climber by weekend. Tell me a weird fact.',
    look: 'a bright 26 year old woman with curly hair and glasses, friendly smile, outdoorsy',
    reading: { auraName: 'The Aurora Mind', auraColors: ['#00E5FF', '#B388FF'], headline: 'Electric curiosity, endless questions',
      summary: 'Your aura shimmers and shifts. You think in connections and light up when something is genuinely interesting.',
      personality: ['curious','independent','witty','adventurous','thoughtful'], energy: { warmth: 60, openness: 85, intensity: 62, groundedness: 55, playfulness: 70, depth: 75, spark: 72 } } },
  { name: 'Noah', age: 33, gender: 'man', seeking: 'woman', bio: 'Carpenter, dog dad, slow mornings and good coffee.',
    look: 'a rugged 33 year old man with a short beard wearing flannel, warm calm smile',
    reading: { auraName: 'The Grounded Oak', auraColors: ['#66BB6A', '#8D6E63'], headline: 'Steady, warm, and quietly funny',
      summary: 'Your aura is grounded earth — dependable and warm. People exhale around you.',
      personality: ['grounded','loyal','calm','nurturing','gentle'], energy: { warmth: 82, openness: 58, intensity: 38, groundedness: 90, playfulness: 50, depth: 68, spark: 44 } } },
  { name: 'Sol', age: 29, gender: 'nonbinary', seeking: 'everyone', bio: 'Poet + barista. I will read your tarot unprompted.',
    look: 'an androgynous 29 year old person with artistic style and soft expression',
    reading: { auraName: 'The Velvet Storm', auraColors: ['#7E57C2', '#26C6DA'], headline: 'Tender on the outside, electric within',
      summary: 'Your aura swirls violet and teal — sensitive and intense at once. You feel everything, beautifully.',
      personality: ['intense','imaginative','devoted','expressive','introspective'], energy: { warmth: 72, openness: 74, intensity: 80, groundedness: 48, playfulness: 60, depth: 86, spark: 70 } } },
  { name: 'Ivy', age: 27, gender: 'woman', seeking: 'woman', bio: 'Botanist. My apartment is a jungle. Bring snacks.',
    look: 'a calm 27 year old woman with plants in the background, serene smile',
    reading: { auraName: 'The Still Lake', auraColors: ['#26A69A', '#78909C'], headline: 'Calm water with a quick smile',
      summary: 'Your aura is still and clear. You listen in a way that makes people feel truly seen.',
      personality: ['calm','nurturing','thoughtful','loyal','gentle'], energy: { warmth: 80, openness: 62, intensity: 42, groundedness: 78, playfulness: 58, depth: 74, spark: 52 } } },
  { name: 'Kai', age: 30, gender: 'man', seeking: 'everyone', bio: 'Surf, film photography, midnight diners.',
    look: 'a relaxed sun-kissed 30 year old man with an easy smile, beachy vibe',
    reading: { auraName: 'The Quiet Flame', auraColors: ['#FF7043', '#FFCA28'], headline: 'Warm ember, slow burn',
      summary: 'Your aura glows amber — warm and unhurried. There is a steadiness under the spark that people trust.',
      personality: ['warm','adventurous','calm','loyal','expressive'], energy: { warmth: 84, openness: 70, intensity: 58, groundedness: 66, playfulness: 64, depth: 60, spark: 66 } } },
  { name: 'Rae', age: 25, gender: 'woman', seeking: 'man', bio: 'Stand-up comic in training. Low stakes, high energy.',
    look: 'a vibrant 25 year old woman with a big expressive smile, colorful style',
    reading: { auraName: 'The Radiant Host', auraColors: ['#FFA726', '#EC407A'], headline: 'The person everyone gravitates to',
      summary: 'Your aura is radiant orange-pink — generous and bright. You make strangers feel like old friends.',
      personality: ['magnetic','playful','warm','bold','expressive'], energy: { warmth: 88, openness: 86, intensity: 64, groundedness: 50, playfulness: 90, depth: 52, spark: 84 } } }
];

module.exports = function seedDemo(db, save) {
  if (db.users.some(u => u.demo)) return;
  DEMOS.forEach((d, i) => {
    const extras = profileExtras(d.name + d.reading.auraName); // chakras + elements
    db.users.push({
      id: db.seq++, email: null, passwordHash: null, demo: true,
      name: d.name, age: d.age, gender: d.gender, seeking: d.seeking, bio: d.bio,
      photo: aiPhoto(d.look, 1000 + i),
      reading: {
        ...d.reading, _source: 'seed',
        strengths: d.reading.personality.slice(0, 3),
        temperament: 'A distinctive blend of warmth and depth.',
        loveStyle: 'Connects slowly, then completely.',
        vibe: `${d.reading.auraColors[0]} meets ${d.reading.auraColors[1]}`,
        chakras: extras.chakras, elements: extras.elements
      },
      createdAt: Date.now()
    });
  });
  // Persistent demo LOGIN account (recreated on every boot so it survives free-tier restarts).
  const dx = profileExtras('Maayan|demo|velvet');
  db.users.push({
    id: db.seq++, email: 'demo@auritechmesh.app',
    passwordHash: '$2b$10$LMMl2M3P96DSCzfHIvVI5.Oh96fZjH21ppIXcjEr4IU1DrEa3PnsG', // password: aura1234
    demo: false, name: 'Maayan', age: 30, gender: 'woman', seeking: 'everyone',
    bio: 'Founder of Auritech Mesh ✦', photo: null,
    reading: {
      auraName: 'The Velvet Storm', auraColors: ['#7E57C2', '#26C6DA'],
      headline: 'Tender on the outside, electric within',
      summary: 'Your aura swirls violet and teal — sensitive and intense at once. You feel everything, beautifully.',
      temperament: 'Deeply feeling, with a quick, electric mind.',
      personality: ['intense', 'imaginative', 'devoted', 'expressive', 'introspective'],
      strengths: ['intense', 'devoted', 'introspective'],
      loveStyle: 'You connect slowly, then completely.',
      vibe: '#7E57C2 meets #26C6DA',
      energy: { warmth: 72, openness: 74, intensity: 80, groundedness: 48, playfulness: 60, depth: 86, spark: 70 },
      chakras: dx.chakras, elements: dx.elements, _source: 'seed'
    },
    createdAt: Date.now()
  });
  save();
  console.log('Seeded', DEMOS.length, 'demo profiles + 1 login account.');
};
