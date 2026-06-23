// Tiny JSON file-backed store. Zero native deps; fine for an MVP.
// NOTE: on Render's free ephemeral disk this resets on redeploy. Add a Render
// Disk mounted at DATA_DIR for persistence later.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let db = { users: [], likes: [], messages: [], seq: 1 };

function load() {
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db.users = db.users || [];
    db.likes = db.likes || [];
    db.messages = db.messages || [];
    db.seq = db.seq || 1;
  } catch (e) {
    save();
  }
}

function save() {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

function nextId() {
  const id = db.seq++;
  save();
  return id;
}

load();

module.exports = { db, save, nextId, UPLOADS_DIR };
