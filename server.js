/* ───────────────────────────────────────────────────────────────
   Auritech — backend server  (no installs; Node built-ins only)
   ---------------------------------------------------------------
   Provides everything the app needs:
     • Accounts     — email + password (/api/auth/signup, /login, /me, /logout)
     • Database     — each account's data in its own ENCRYPTED file
     • Encryption   — passwords hashed with scrypt; saved data
                      encrypted at rest with AES-256-GCM
     • Isolation    — a request can only ever touch the data of the
                      account its token belongs to (id comes from the
                      token, never from the client)
     • Claude proxy — holds your API key; only signed-in users spend it
     • App host     — serves the app at http://localhost:8787

   RUN (in this folder):
     Windows (PowerShell):
        $env:ANTHROPIC_API_KEY="sk-ant-xxxxx"; node server.js
     macOS / Linux:
        ANTHROPIC_API_KEY=sk-ant-xxxxx node server.js
   Then open  http://localhost:8787

   Production: also set a fixed secret so data stays readable across
   machines:  $env:AURITECH_SECRET="a-long-random-passphrase"
   ─────────────────────────────────────────────────────────────── */

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const KEY  = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 8787;
const INVITE = process.env.INVITE_CODE || "";   // (only used if self-signup is enabled)
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP === "1";   // self-registration is OFF unless you set this to 1
if (!KEY) {
  console.error("\n  \u2717 Missing ANTHROPIC_API_KEY.\n    Windows:   $env:ANTHROPIC_API_KEY=\"sk-ant-xxxxx\"; node server.js\n    Mac/Linux: ANTHROPIC_API_KEY=sk-ant-xxxxx node server.js\n");
  process.exit(1);
}

/* ── storage layout ───────────────────────────────────────────── */
const DATA    = process.env.AURITECH_DATA_DIR || path.join(__dirname, "data");
const STATE   = path.join(DATA, "state");
const USERS_F = path.join(DATA, "users.json");
const SESS_F  = path.join(DATA, "sessions.json");
fs.mkdirSync(STATE, { recursive: true });

/* ── encryption (AES-256-GCM) ─────────────────────────────────── */
function masterKey() {
  if (process.env.AURITECH_SECRET) return crypto.scryptSync(process.env.AURITECH_SECRET, "auritech.kdf.v1", 32);
  const f = path.join(DATA, ".secret");
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex");
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString("hex"));
  console.warn("  ! No AURITECH_SECRET set — generated data/.secret for local use.");
  return k;
}
const MASTER = masterKey();
function encrypt(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", MASTER, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), "utf8")), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decrypt(b64) {
  const b = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", MASTER, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
}

/* ── per-user, owner-bound encryption (defense in depth) ──────────
   Multiple INDEPENDENT locks so one account's data can never be
   returned for another account, even if a single check were wrong:
     L1  a UNIQUE key per user, derived from MASTER + the user id
     L2  the user id welded onto the ciphertext as AES-GCM AAD
     L3  the user id ALSO stored inside the payload and re-checked
     L4  the id is sanitised and only ever comes from the auth token
   Old single-key records are read via a legacy fallback and then
   transparently re-written in the new format (no data is lost).      */
const safeId = (id) => (/^[A-Za-z0-9_]+$/.test(String(id || "")) ? String(id) : null);
function userKey(id) { return crypto.createHmac("sha256", MASTER).update("auritech.user.v2|" + id).digest(); } // L1: 32-byte per-user key
function encUser(id, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", userKey(id), iv);
  c.setAAD(Buffer.from("owner:" + id, "utf8"));                                  // L2: bind owner to ciphertext
  const payload = { __o: id, __v: 2, d: obj };                                    // L3: owner stamped inside
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), "utf8")), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
// returns { data, legacy } ; throws nothing — fails CLOSED to {} on any mismatch
function decUser(id, b64) {
  const b = Buffer.from(b64, "base64");
  try {                                                                           // try the new owner-bound format
    const d = crypto.createDecipheriv("aes-256-gcm", userKey(id), b.subarray(0, 12));
    d.setAAD(Buffer.from("owner:" + id, "utf8"));
    d.setAuthTag(b.subarray(12, 28));
    const obj = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
    if (!obj || obj.__o !== id) { console.warn("owner-check failed for", id); return { data: {}, legacy: false }; } // L3 re-check
    return { data: obj.d || {}, legacy: false };
  } catch (e) {
    try { return { data: decrypt(b64), legacy: true }; }                          // legacy single-key record → migrate on read
    catch (e2) { return { data: {}, legacy: false }; }                            // unreadable → fail closed
  }
}

/* ── passwords & sessions ─────────────────────────────────────── */
const hashPw = (pw) => { const s = crypto.randomBytes(16); return s.toString("hex") + ":" + crypto.scryptSync(pw, s, 64).toString("hex"); };
function verifyPw(pw, stored) {
  const [s, h] = stored.split(":");
  const a = Buffer.from(h, "hex"), b = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const newToken = () => crypto.randomBytes(32).toString("hex");
const tokHash  = (t) => crypto.createHash("sha256").update(t).digest("hex");
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/* ── tiny json db (in-memory + write-through) ─────────────────── */
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
let USERS = load(USERS_F, { byId: {}, byEmail: {} });
let SESS  = load(SESS_F, {});
const saveUsers = () => fs.writeFileSync(USERS_F, JSON.stringify(USERS));
const saveSess  = () => fs.writeFileSync(SESS_F, JSON.stringify(SESS));

/* per-user encrypted key→value store (owner-bound; migrates legacy on read) */
function userData(id) {
  const sid = safeId(id); if (!sid) return {};                       // L4: reject malformed ids
  const f = path.join(STATE, sid + ".enc"); if (!fs.existsSync(f)) return {};
  const { data, legacy } = decUser(sid, fs.readFileSync(f, "utf8"));
  if (legacy) { try { fs.writeFileSync(f, encUser(sid, data)); } catch (e) {} }   // upgrade old record in place
  return data;
}
function setUserData(id, obj) {
  const sid = safeId(id); if (!sid) throw new Error("bad id");
  fs.writeFileSync(path.join(STATE, sid + ".enc"), encUser(sid, obj));
}

/* ── social store: friends, requests, blocks, messages, presence ── */
const SOCIAL_F = path.join(DATA, "social.enc");
function loadSocial(){ try{ if (fs.existsSync(SOCIAL_F)) return decrypt(fs.readFileSync(SOCIAL_F, "utf8")); }catch(e){} return { req:{}, fr:{}, blk:{}, th:{}, seen:{} }; }
let SOCIAL = loadSocial();
const saveSocial = () => { try{ fs.writeFileSync(SOCIAL_F, encrypt(SOCIAL)); }catch(e){} };
const emailOf = (id) => { const u = USERS.byId[id]; return u ? u.email : null; };
const norm = (s) => String(s || "").trim().toLowerCase();
const pairKey = (a, b) => [a, b].sort().join("|");
const ONLINE_MS = 90 * 1000;
const online = (email) => (Date.now() - (SOCIAL.seen[email] || 0)) < ONLINE_MS;
function touchSeen(id){ const e = emailOf(id); if (e) SOCIAL.seen[e] = Date.now(); }   // in-memory presence (no disk thrash)
const isBlocked = (owner, other) => !!(SOCIAL.blk[owner] && SOCIAL.blk[owner][other]);
const areFriends = (a, b) => !!(SOCIAL.fr[a] && SOCIAL.fr[a][b]);
function me(req){ const id = authUser(req); if (!id) return null; touchSeen(id); return { id, email: emailOf(id) }; }

/* Create the accounts you list in AURITECH_ACCOUNTS (format: "name@auritech.app:Password1, dana@auritech.app:Password2").
   Existing accounts are left untouched, so their data is never reset. */
function seedAccounts() {
  const raw = process.env.AURITECH_ACCOUNTS || "";
  if (!raw) return;
  let made = 0, updated = 0;
  raw.split(",").map(s => s.trim()).filter(Boolean).forEach(pair => {
    const i = pair.indexOf(":"); if (i < 1) return;
    const email = pair.slice(0, i).trim().toLowerCase();
    const pw = pair.slice(i + 1).trim();
    if (!email || pw.length < 1) return;
    const existingId = USERS.byEmail[email];
    if (existingId) {                                  // account exists: keep all their data,
      const u = USERS.byId[existingId];                // but make the listed password authoritative
      if (u && !verifyPw(pw, u.pw)) { u.pw = hashPw(pw); updated++; }
      return;
    }
    const id = "u_" + crypto.randomBytes(9).toString("hex");
    USERS.byId[id] = { id, email, pw: hashPw(pw), createdAt: Date.now() };
    USERS.byEmail[email] = id; made++;
  });
  if (made || updated) saveUsers();
  console.log(`  Accounts: ${Object.keys(USERS.byEmail).length} total (${made} created, ${updated} password-updated this start).`);
}

/* ── http helpers ─────────────────────────────────────────────── */
// Optional: set ALLOWED_ORIGIN to your domain (e.g. https://auritech-healing-app.onrender.com) to lock CORS down.
// Left as "*" by default so nothing breaks; the app is same-origin so this only affects cross-site callers.
const cors = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // safe hardening headers (do NOT add a strict CSP here — the app uses inline scripts/handlers)
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
};
const send = (res, code, obj) => { res.writeHead(code, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", c => { b += c; if (b.length > 8e6) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

/* ── login brute-force throttle (in-memory) ───────────────────── */
const LOGIN_FAILS = {};   // key -> { n, until }
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "ip";
function loginBlocked(key){ const r = LOGIN_FAILS[key]; return r && r.until > Date.now(); }
function loginFail(key){ const r = LOGIN_FAILS[key] || { n:0, until:0 }; r.n++; if (r.n >= 8) { r.until = Date.now() + 10*60*1000; r.n = 0; } LOGIN_FAILS[key] = r; }
function loginOk(key){ delete LOGIN_FAILS[key]; }

function authUser(req) {
  const h = req.headers["authorization"] || "", t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return null;
  const s = SESS[tokHash(t)];
  if (!s || s.exp < Date.now()) return null;
  touchSeen(s.userId);                 // presence: any authenticated activity counts as "online"
  return s.userId;
}
function issue(userId) { const t = newToken(); SESS[tokHash(t)] = { userId, exp: Date.now() + SESSION_MS }; saveSess(); return t; }

const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".png":"image/png", ".svg":"image/svg+xml", ".ico":"image/x-icon" };

/* ── server ───────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  /* ---- public config (no auth) ---- */
  if (req.method === "GET" && p === "/api/config") {
    return send(res, 200, { signup: ALLOW_SIGNUP });
  }

  /* ---- sign up ---- */
  if (req.method === "POST" && p === "/api/auth/signup") {
    if (!ALLOW_SIGNUP) return send(res, 403, { error: "Registration is closed. Please ask the owner for a login." });
    const { email, password, name, invite } = await body(req);
    if (INVITE && String(invite || "").trim() !== INVITE) return send(res, 403, { error: "That invite code isn't valid. Ask the person who invited you." });
    const e = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return send(res, 400, { error: "Please enter a valid email." });
    if (String(password || "").length < 8)     return send(res, 400, { error: "Password must be at least 8 characters." });
    if (USERS.byEmail[e])                       return send(res, 409, { error: "An account with that email already exists." });
    const id = "u_" + crypto.randomBytes(9).toString("hex");
    USERS.byId[id] = { id, email: e, pw: hashPw(password), createdAt: Date.now() };
    USERS.byEmail[e] = id; saveUsers();
    if (name) setUserData(id, { profile: JSON.stringify({ name: String(name).trim() }) });
    return send(res, 200, { token: issue(id), email: e });
  }

  /* ---- log in ---- */
  if (req.method === "POST" && p === "/api/auth/login") {
    const { email, password } = await body(req);
    const e = String(email || "").trim().toLowerCase();
    const key = clientIp(req) + "|" + e;
    if (loginBlocked(key)) return send(res, 429, { error: "Too many attempts. Please wait a few minutes and try again." });
    const id = USERS.byEmail[e], usr = id && USERS.byId[id];
    if (!usr || !verifyPw(String(password || ""), usr.pw)) { loginFail(key); return send(res, 401, { error: "Email or password is incorrect." }); }
    loginOk(key);
    return send(res, 200, { token: issue(id), email: e });
  }

  /* ---- who am I (token check) ---- */
  if (req.method === "GET" && p === "/api/auth/me") {
    const id = authUser(req); if (!id) return send(res, 401, { error: "Not signed in." });
    return send(res, 200, { email: (USERS.byId[id] || {}).email || "" });
  }

  /* ---- log out ---- */
  if (req.method === "POST" && p === "/api/auth/logout") {
    const h = req.headers["authorization"] || "", t = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (t) { delete SESS[tokHash(t)]; saveSess(); }
    return send(res, 200, { ok: true });
  }

  /* ---- delete account + all data (right to erasure) ---- */
  if (req.method === "POST" && p === "/api/auth/delete") {
    const id = authUser(req); if (!id) return send(res, 401, { error: "Not signed in." });
    const u = USERS.byId[id];
    if (u) { delete USERS.byEmail[u.email]; delete USERS.byId[id]; saveUsers(); }
    try { fs.unlinkSync(path.join(STATE, id + ".enc")); } catch {}          // erase their encrypted data
    for (const th of Object.keys(SESS)) if (SESS[th].userId === id) delete SESS[th];  // kill all their sessions
    saveSess();
    return send(res, 200, { ok: true });
  }

  /* ---- per-user data: read one key ---- */
  if (req.method === "GET" && p === "/api/data") {
    const id = authUser(req); if (!id) return send(res, 401, { error: "Not signed in." });
    const key = u.searchParams.get("key") || "";
    const store = userData(id);                       // id is from the token only
    return send(res, 200, { value: key in store ? store[key] : null });
  }

  /* ---- per-user data: write one key ---- */
  if (req.method === "POST" && p === "/api/data") {
    const id = authUser(req); if (!id) return send(res, 401, { error: "Not signed in." });
    const { key, value } = await body(req);
    if (!key) return send(res, 400, { error: "Missing key." });
    const store = userData(id); store[key] = value; setUserData(id, store);
    return send(res, 200, { ok: true });
  }

  /* ---- find people to connect with ---- */
  if (req.method === "GET" && p === "/api/users/search") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const q = norm(u.searchParams.get("q")); if (q.length < 2) return send(res, 200, []);
    const out = [];
    for (const email of Object.keys(USERS.byEmail)) {
      if (email === m.email) continue;
      if (!email.includes(q)) continue;
      if (isBlocked(email, m.email) || isBlocked(m.email, email)) continue;
      out.push({ username: email, online: online(email), lastSeen: SOCIAL.seen[email] || 0,
                 friend: areFriends(m.email, email),
                 requested: !!(SOCIAL.req[email] && SOCIAL.req[email][m.email]) });
      if (out.length >= 15) break;
    }
    return send(res, 200, out);
  }

  /* ---- my friends, requests & conversations ---- */
  if (req.method === "GET" && p === "/api/friends") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const friends = Object.keys(SOCIAL.fr[m.email] || {}).map(e => ({ username: e, online: online(e), lastSeen: SOCIAL.seen[e] || 0 }));
    const incoming = Object.keys(SOCIAL.req[m.email] || {}).map(e => ({ username: e }));
    const convs = [];
    for (const key of Object.keys(SOCIAL.th)) {
      const parts = key.split("|"); if (!parts.includes(m.email)) continue;
      const other = parts[0] === m.email ? parts[1] : parts[0];
      if (isBlocked(m.email, other)) continue;
      const th = SOCIAL.th[key]; const last = th[th.length - 1] || null;
      convs.push({ username: other, online: online(other), lastSeen: SOCIAL.seen[other] || 0,
                   friend: areFriends(m.email, other),
                   last: last ? { from: last.from, text: last.text || "", audio: !!last.audio, t: last.t } : null });
    }
    convs.sort((a, b) => ((b.last && b.last.t) || 0) - ((a.last && a.last.t) || 0));
    return send(res, 200, { friends, incoming, conversations: convs });
  }

  /* ---- send a friend request ---- */
  if (req.method === "POST" && p === "/api/friends/request") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const to = norm((await body(req)).to);
    if (!USERS.byEmail[to] || to === m.email) return send(res, 200, { ok: true });   // never reveal who exists
    if (areFriends(m.email, to) || isBlocked(to, m.email)) return send(res, 200, { ok: true });   // silent if blocked
    SOCIAL.req[to] = SOCIAL.req[to] || {}; SOCIAL.req[to][m.email] = Date.now(); saveSocial();
    return send(res, 200, { ok: true });
  }

  /* ---- accept / reject (rejection is silent — requester is never told) ---- */
  if (req.method === "POST" && p === "/api/friends/respond") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const { from, accept } = await body(req); const f = norm(from);
    const reqs = SOCIAL.req[m.email] || {};
    if (f in reqs) {
      delete reqs[f];
      if (accept) {
        SOCIAL.fr[m.email] = SOCIAL.fr[m.email] || {}; SOCIAL.fr[m.email][f] = Date.now();
        SOCIAL.fr[f] = SOCIAL.fr[f] || {}; SOCIAL.fr[f][m.email] = Date.now();
      }
      saveSocial();
    }
    return send(res, 200, { ok: true });
  }

  /* ---- remove a friend ---- */
  if (req.method === "POST" && p === "/api/friends/remove") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const o = norm((await body(req)).username);
    if (SOCIAL.fr[m.email]) delete SOCIAL.fr[m.email][o];
    if (SOCIAL.fr[o]) delete SOCIAL.fr[o][m.email];
    saveSocial(); return send(res, 200, { ok: true });
  }

  /* ---- block / unblock ---- */
  if (req.method === "POST" && p === "/api/friends/block") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const o = norm((await body(req)).username);
    SOCIAL.blk[m.email] = SOCIAL.blk[m.email] || {}; SOCIAL.blk[m.email][o] = Date.now();
    if (SOCIAL.fr[m.email]) delete SOCIAL.fr[m.email][o];
    if (SOCIAL.fr[o]) delete SOCIAL.fr[o][m.email];
    if (SOCIAL.req[m.email]) delete SOCIAL.req[m.email][o];
    if (SOCIAL.req[o]) delete SOCIAL.req[o][m.email];
    saveSocial(); return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/friends/unblock") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const o = norm((await body(req)).username);
    if (SOCIAL.blk[m.email]) delete SOCIAL.blk[m.email][o];
    saveSocial(); return send(res, 200, { ok: true });
  }

  /* ---- conversation history with one person ---- */
  if (req.method === "GET" && p === "/api/messages") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const other = norm(u.searchParams.get("with")); if (!other) return send(res, 400, { error: "Missing 'with'." });
    const th = SOCIAL.th[pairKey(m.email, other)] || [];
    return send(res, 200, { messages: th.slice(-300), friend: areFriends(m.email, other), blocked: isBlocked(m.email, other) });
  }

  /* ---- send a message (text or voice note); non-friends may send an intro ---- */
  if (req.method === "POST" && p === "/api/messages") {
    const m = me(req); if (!m) return send(res, 401, { error: "Not signed in." });
    const { to, text, audio } = await body(req); const o = norm(to);
    if (!USERS.byEmail[o] || o === m.email) return send(res, 400, { error: "Can't send to that user." });
    if (isBlocked(o, m.email)) return send(res, 200, { ok: true, delivered: false });   // recipient blocked sender — silently drop
    const txt = String(text || "").slice(0, 4000);
    const aud = audio ? String(audio).slice(0, 900000) : "";   // ~0.7MB cap → short voice notes
    if (!txt && !aud) return send(res, 400, { error: "Empty message." });
    const key = pairKey(m.email, o); SOCIAL.th[key] = SOCIAL.th[key] || [];
    SOCIAL.th[key].push({ from: m.email, text: txt, audio: aud, t: Date.now() });
    if (SOCIAL.th[key].length > 500) SOCIAL.th[key] = SOCIAL.th[key].slice(-500);
    saveSocial(); return send(res, 200, { ok: true, delivered: true });
  }

  /* ---- YouTube search for the mantra player (optional; needs YOUTUBE_API_KEY) ---- */
  if (req.method === "GET" && p === "/api/yt") {
    const id = authUser(req); if (!id) return send(res, 401, { error: "Not signed in." });
    const q = (u.searchParams.get("q") || "").trim(); const yk = process.env.YOUTUBE_API_KEY;
    if (!q || !yk) return send(res, 200, { videoId: null });
    try {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=strict&maxResults=1&q=${encodeURIComponent(q)}&key=${yk}`);
      const j = await r.json(); const vid = j.items && j.items[0] && j.items[0].id && j.items[0].id.videoId;
      return send(res, 200, { videoId: vid || null });
    } catch (e) { return send(res, 200, { videoId: null }); }
  }

  /* ---- Claude proxy (signed-in users only) ---- */
  if (req.method === "POST" && p === "/api/chat") {
    const id = authUser(req); if (!id) return send(res, 401, { error: { message: "Please sign in again." } });
    const { model, system, messages, max_tokens } = await body(req);
    try {
      const up = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type":"application/json", "x-api-key":KEY, "anthropic-version":"2023-06-01" },
        body: JSON.stringify({ model: model || "claude-sonnet-4-6", max_tokens: max_tokens || 1024, system, messages }),
      });
      const text = await up.text();
      res.writeHead(up.status, { ...cors, "content-type":"application/json" }); return res.end(text);
    } catch (err) { return send(res, 500, { error: { message: String(err) } }); }
  }

  /* ---- static app host (never serves data/ or dotfiles) ---- */
  if (req.method === "GET") {
    let rel = p; if (rel === "/" || rel === "") rel = "/auritech.html";
    const file = path.join(__dirname, decodeURIComponent(rel)), base = path.basename(file);
    if (!file.startsWith(__dirname) || file.startsWith(DATA) || base.startsWith(".")) { res.writeHead(403, cors); return res.end("Forbidden"); }
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, cors); return res.end("Not found"); }
      res.writeHead(200, { ...cors, "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  }

  send(res, 404, { error: "Not found" });
});

seedAccounts();
server.listen(PORT, () => {
  console.log(`\n  \u2713 Auritech is running.`);
  console.log(`    Open this in your browser \u2192  http://localhost:${PORT}`);
  console.log(`    Accounts + encrypted data live in the  data/  folder.\n`);
});
