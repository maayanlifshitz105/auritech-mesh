const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { db, save, nextId, UPLOADS_DIR } = require('./db');
const { generateReading, resonance } = require('./aura');
const seedDemo = require('./seed');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'auritech-dev-secret-change-me';

app.use(express.json({ limit: '12mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = (file.originalname.match(/\.(jpe?g|png|webp)$/i) || ['.jpg'])[0];
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ---- helpers ----
function sign(user) { return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'not signed in' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === id);
    if (!user) return res.status(401).json({ error: 'invalid session' });
    req.user = user;
    next();
  } catch (e) { return res.status(401).json({ error: 'invalid session' }); }
}
function publicUser(u, me) {
  const out = {
    id: u.id, name: u.name, age: u.age, gender: u.gender, seeking: u.seeking,
    bio: u.bio, photo: u.photo || null, reading: u.reading || null, demo: !!u.demo
  };
  if (me && u.reading && me.reading) out.resonance = resonance(me.reading.energy, u.reading.energy);
  return out;
}
function actedOn(meId, otherId) {
  return db.likes.find(l => l.from === meId && l.to === otherId);
}
function mutualMatch(aId, bId) {
  const a = db.likes.find(l => l.from === aId && l.to === bId && l.action === 'like');
  const b = db.likes.find(l => l.from === bId && l.to === aId && l.action === 'like');
  return a && b;
}

// ---- auth ----
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, age, gender, seeking, bio } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password and name are required' });
  if (db.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'that email is already registered' });
  const user = {
    id: nextId(), email, passwordHash: bcrypt.hashSync(password, 10),
    name, age: age || null, gender: gender || '', seeking: seeking || '',
    bio: bio || '', photo: null, reading: null, demo: false, createdAt: Date.now()
  };
  db.users.push(user); save();
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u => u.email && u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash || ''))
    return res.status(401).json({ error: 'wrong email or password' });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', auth, (req, res) => {
  const { name, age, gender, seeking, bio } = req.body || {};
  const u = req.user;
  if (name !== undefined) u.name = name;
  if (age !== undefined) u.age = age;
  if (gender !== undefined) u.gender = gender;
  if (seeking !== undefined) u.seeking = seeking;
  if (bio !== undefined) u.bio = bio;
  save();
  res.json({ user: publicUser(u) });
});

// ---- aura scan ----
app.post('/api/scan', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no photo uploaded' });
  try {
    const buf = fs.readFileSync(req.file.path);
    const mediaType = req.file.mimetype || 'image/jpeg';
    const reading = await generateReading(buf, mediaType);
    req.user.photo = '/uploads/' + path.basename(req.file.path);
    req.user.reading = reading;
    save();
    res.json({ user: publicUser(req.user), reading });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'aura scan failed' });
  }
});

// ---- discover ----
app.get('/api/discover', auth, (req, res) => {
  const me = req.user;
  const wantGender = me.seeking;
  let candidates = db.users.filter(u => u.id !== me.id && u.reading);
  candidates = candidates.filter(u => !actedOn(me.id, u.id));
  if (wantGender && wantGender !== 'everyone') candidates = candidates.filter(u => !u.gender || u.gender === wantGender);
  const list = candidates.map(u => publicUser(u, me))
    .sort((a, b) => (b.resonance || 0) - (a.resonance || 0));
  res.json({ candidates: list });
});

// ---- like / pass ----
app.post('/api/like', auth, (req, res) => {
  const { targetId, action } = req.body || {};
  const target = db.users.find(u => u.id === targetId);
  if (!target) return res.status(404).json({ error: 'no such person' });
  if (!actedOn(req.user.id, targetId)) {
    db.likes.push({ from: req.user.id, to: targetId, action: action === 'like' ? 'like' : 'pass', at: Date.now() });
    // demo users always like you back, so matches feel alive
    if (action === 'like' && target.demo && !actedOn(target.id, req.user.id)) {
      db.likes.push({ from: target.id, to: req.user.id, action: 'like', at: Date.now() });
    }
    save();
  }
  const matched = action === 'like' && mutualMatch(req.user.id, targetId);
  res.json({ matched: !!matched, match: matched ? publicUser(target, req.user) : null });
});

// ---- matches ----
app.get('/api/matches', auth, (req, res) => {
  const me = req.user;
  const matches = db.users.filter(u => u.id !== me.id && mutualMatch(me.id, u.id))
    .map(u => {
      const last = [...db.messages].reverse().find(m =>
        (m.from === me.id && m.to === u.id) || (m.from === u.id && m.to === me.id));
      return { ...publicUser(u, me), lastMessage: last ? last.text : null, lastAt: last ? last.at : null };
    })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (b.resonance || 0) - (a.resonance || 0));
  res.json({ matches });
});

// ---- messages ----
app.get('/api/messages/:userId', auth, (req, res) => {
  const otherId = Number(req.params.userId);
  if (!mutualMatch(req.user.id, otherId)) return res.status(403).json({ error: 'not matched' });
  const msgs = db.messages.filter(m =>
    (m.from === req.user.id && m.to === otherId) || (m.from === otherId && m.to === req.user.id))
    .map(m => ({ from: m.from, to: m.to, text: m.text, at: m.at, mine: m.from === req.user.id }));
  res.json({ messages: msgs });
});

app.post('/api/messages', auth, (req, res) => {
  const { to, text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'empty message' });
  if (!mutualMatch(req.user.id, to)) return res.status(403).json({ error: 'not matched' });
  const msg = { from: req.user.id, to, text: text.trim().slice(0, 1000), at: Date.now() };
  db.messages.push(msg); save();
  const target = db.users.find(u => u.id === to);
  // demo users send a friendly auto-reply so chat feels alive
  if (target && target.demo) {
    const replies = [
      'I literally felt our auras click 😊 what are you up to this weekend?',
      'okay our resonance score is not lying haha. tell me something real about you.',
      'your energy is so warm. coffee sometime?',
      'I had a feeling we would match. what lights you up these days?'
    ];
    db.messages.push({ from: to, to: req.user.id, text: replies[Math.floor(Math.random() * replies.length)], at: Date.now() + 1 });
    save();
  }
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, aura: process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock' }));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

seedDemo(db, save);
app.listen(PORT, () => console.log(`Auritech Mesh running on :${PORT} (aura: ${process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock'})`));
