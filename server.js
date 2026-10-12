/**
 * Anonymous ID-based real-time chat — backend
 * Express (REST auth + data) + Socket.io (live delivery) + SQLite (storage)
 * No phone numbers, no emails: just a self-chosen Unique ID + password.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs'); // pure-JS bcrypt, same hashing scheme, no native build
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+ / 24, no native build needed
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const TTL_MS = 24 * 60 * 60 * 1000; // messages disappear after 24 hours
const UID_RE = /^[A-Za-z0-9_]{3,20}$/;
const MAX_MSG = 1000;

/* ------------------------------ Database ------------------------------ */
const db = new DatabaseSync(path.join(__dirname, 'chat.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hash TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id, to_id, created_at);
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
`);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

// Purge expired messages every 5 minutes (and once at boot)
const purge = () => db.prepare('DELETE FROM messages WHERE created_at < ?').run(now() - TTL_MS);
purge();
setInterval(purge, 5 * 60 * 1000).unref();

/* ----------------------------- Auth helpers ---------------------------- */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)')
    .run(sha(token), userId, now());
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.uid, u.bio FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ?`).get(sha(token));
  return row ? { id: Number(row.id), uid: row.uid, bio: row.bio } : null;
}
const isBlocked = (a, b) =>
  !!db.prepare(`SELECT 1 FROM blocks WHERE (blocker_id=@a AND blocked_id=@b) OR (blocker_id=@b AND blocked_id=@a)`)
    .get({ a, b });

// Tiny in-memory rate limiter for login/register (per IP)
const attempts = new Map();
function limited(ip) {
  const rec = attempts.get(ip) || { n: 0, t: now() };
  if (now() - rec.t > 15 * 60 * 1000) { rec.n = 0; rec.t = now(); }
  rec.n++; attempts.set(ip, rec);
  return rec.n > 30;
}

/* ------------------------------ Express app ---------------------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

app.post('/api/register', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try later.' });
  const uid = String(req.body.uid || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const bio = String(req.body.bio || '').trim().slice(0, 60);
  if (!UID_RE.test(uid)) return res.status(400).json({ error: 'ID: 3–20 letters, numbers or _' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  if (db.prepare('SELECT 1 FROM users WHERE uid = ?').get(uid))
    return res.status(409).json({ error: 'That ID is taken' });

  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare('INSERT INTO users (uid, hash, bio, created_at, last_seen) VALUES (?,?,?,?,?)')
    .run(uid, hash, bio, now(), now());
  res.json({ token: createSession(Number(info.lastInsertRowid)), me: { uid, bio } });
});

app.post('/api/login', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try later.' });
  const uid = String(req.body.uid || '').trim().toUpperCase();
  const password = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if (!u || !bcrypt.compareSync(password, u.hash))
    return res.status(401).json({ error: 'Wrong ID or password' });
  res.json({ token: createSession(Number(u.id)), me: { uid: u.uid, bio: u.bio } });
});

app.post('/api/logout', auth, (req, res) => {
  const h = req.headers.authorization.slice(7);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(h));
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ uid: req.user.uid, bio: req.user.bio }));

// Dashboard list: people you've talked to first, then everyone else
app.get('/api/chats', auth, (req, res) => {
  const cut = now() - TTL_MS;
  const pair = `((m.from_id=@me AND m.to_id=u.id) OR (m.from_id=u.id AND m.to_id=@me)) AND m.created_at>@cut`;
  const rows = db.prepare(`
    SELECT u.uid, u.bio,
      (SELECT text FROM messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS last_text,
      (SELECT created_at FROM messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.from_id=u.id AND m.to_id=@me
         AND m.read_at IS NULL AND m.created_at>@cut) AS unread
    FROM users u
    WHERE u.id != @me
      AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=@me)
      AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=@me)
    ORDER BY (last_at IS NULL), last_at DESC, u.last_seen DESC
    LIMIT 50`).all({ me: req.user.id, cut });
  res.json(rows.map((r) => ({ ...r, online: isOnline(r.uid) })));
});

// Message history for one conversation (last 24h only)
app.get('/api/messages/:uid', auth, (req, res) => {
  const other = db.prepare('SELECT id, uid, bio FROM users WHERE uid = ?').get(String(req.params.uid).toUpperCase());
  if (!other) return res.status(404).json({ error: 'User not found' });
  const rows = db.prepare(`
    SELECT m.id, fu.uid AS "from", tu.uid AS "to", m.text, m.created_at AS at
    FROM messages m JOIN users fu ON fu.id=m.from_id JOIN users tu ON tu.id=m.to_id
    WHERE ((m.from_id=@me AND m.to_id=@o) OR (m.from_id=@o AND m.to_id=@me)) AND m.created_at>@cut
    ORDER BY m.id ASC`).all({ me: req.user.id, o: other.id, cut: now() - TTL_MS });
  db.prepare('UPDATE messages SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL')
    .run(now(), other.id, req.user.id);
  res.json({
    user: { uid: other.uid, bio: other.bio, online: isOnline(other.uid) },
    messages: rows.map((r) => ({ ...r })),
  });
});

app.delete('/api/messages/:uid', auth, (req, res) => {
  const other = db.prepare('SELECT id FROM users WHERE uid = ?').get(String(req.params.uid).toUpperCase());
  if (!other) return res.status(404).json({ error: 'User not found' });
  db.prepare(`DELETE FROM messages WHERE (from_id=@a AND to_id=@b) OR (from_id=@b AND to_id=@a)`)
    .run({ a: req.user.id, b: other.id });
  res.json({ ok: true });
});

app.post('/api/block/:uid', auth, (req, res) => {
  const other = db.prepare('SELECT id FROM users WHERE uid = ?').get(String(req.params.uid).toUpperCase());
  if (!other || Number(other.id) === req.user.id) return res.status(404).json({ error: 'User not found' });
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?,?)').run(req.user.id, other.id);
  res.json({ ok: true });
});

// Random chat: prefer someone online, fall back to anyone
app.get('/api/random', auth, (req, res) => {
  const all = db.prepare(`
    SELECT uid FROM users WHERE id != @me
      AND id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id=@me)
      AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id=@me)`).all({ me: req.user.id }).map((r) => r.uid);
  if (!all.length) return res.status(404).json({ error: 'Nobody else is here yet' });
  const online = all.filter(isOnline);
  const pool = online.length ? online : all;
  res.json({ uid: pool[Math.floor(Math.random() * pool.length)] });
});

/* ------------------------------- Socket.io ------------------------------ */
const sockets = new Map(); // uid -> Set(socket.id)
const isOnline = (uid) => (sockets.get(uid)?.size || 0) > 0;
const broadcastPresence = () => io.emit('presence', { online: [...sockets.keys()] });

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const me = socket.user;
  socket.join(`u:${me.uid}`); // personal room: every device of this ID joins it
  if (!sockets.has(me.uid)) sockets.set(me.uid, new Set());
  sockets.get(me.uid).add(socket.id);
  broadcastPresence();

  let sentTimes = [];
  socket.on('message:send', (payload, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const text = String(payload?.text || '').trim().slice(0, MAX_MSG);
    const to = db.prepare('SELECT id, uid FROM users WHERE uid = ?').get(String(payload?.to || '').toUpperCase());
    if (!text || !to) return ack({ error: 'Invalid message' });
    if (isBlocked(me.id, to.id)) return ack({ error: 'You cannot message this user' });

    // flood control: max 15 messages / 10 s
    const t = now();
    sentTimes = sentTimes.filter((x) => t - x < 10000);
    if (sentTimes.length >= 15) return ack({ error: 'Slow down' });
    sentTimes.push(t);

    const info = db.prepare('INSERT INTO messages (from_id, to_id, text, created_at) VALUES (?,?,?,?)')
      .run(me.id, to.id, text, t);
    const msg = { id: Number(info.lastInsertRowid), from: me.uid, to: to.uid, text, at: t };
    io.to(`u:${to.uid}`).to(`u:${me.uid}`).emit('message:new', msg); // recipient + sender's other devices
    ack({ ok: true, msg });
  });

  socket.on('message:read', ({ from } = {}) => {
    const other = db.prepare('SELECT id FROM users WHERE uid = ?').get(String(from || '').toUpperCase());
    if (!other) return;
    db.prepare('UPDATE messages SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL')
      .run(now(), other.id, me.id);
  });

  socket.on('typing', ({ to } = {}) => {
    if (typeof to === 'string') io.to(`u:${to.toUpperCase()}`).emit('typing', { from: me.uid });
  });

  socket.on('disconnect', () => {
    const set = sockets.get(me.uid);
    if (set) { set.delete(socket.id); if (!set.size) sockets.delete(me.uid); }
    db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(), me.id);
    broadcastPresence();
  });
});

server.listen(PORT, () => console.log(`Anonymous chat running on http://localhost:${PORT}`));