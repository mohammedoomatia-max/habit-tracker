const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader for local development only (no dependency needed).
// In production, set PASSWORD_PEPPER and PORT as real environment
// variables through your hosting platform instead -- see README.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = (match[2] || '').trim();
    }
  }
}

const { openDb, hashPassword, verifyPassword, generateToken } = require('./db');

const PORT = process.env.PORT || 3000;
const db = openDb();

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

// Every error response follows this shape, so a caller can always tell
// *what* was wrong from the field name, not just that something was.
function fail(res, status, field, message) {
  sendJSON(res, status, { error: message, field });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req, res) {
  const raw = await readBody(req);
  if (!raw || raw.trim().length === 0) {
    fail(res, 400, 'body', 'request body is required');
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(res, 400, 'body', 'request body must be valid JSON');
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Auth ---------------------------------------------------------------

const findUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserByTokenStmt = db.prepare('SELECT * FROM users WHERE token = ?');
const insertUserStmt = db.prepare(
  'INSERT INTO users (email, password_hash, token, created_at) VALUES (?, ?, ?, ?)'
);

async function handleSignup(req, res) {
  const payload = await parseJsonBody(req, res);
  if (payload === null) return;
  const { email, password } = payload;

  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return fail(res, 400, 'email', 'email must be a valid email address');
  }
  if (typeof password !== 'string' || password.length < 8) {
    return fail(res, 400, 'password', 'password must be at least 8 characters');
  }
  if (findUserByEmailStmt.get(email)) {
    return fail(res, 409, 'email', 'an account with this email already exists');
  }

  const token = generateToken();
  const passwordHash = hashPassword(password);
  const info = insertUserStmt.run(email, passwordHash, token, new Date().toISOString());
  return sendJSON(res, 201, { id: Number(info.lastInsertRowid), email, token });
}

async function handleLogin(req, res) {
  const payload = await parseJsonBody(req, res);
  if (payload === null) return;
  const { email, password } = payload;

  if (typeof email !== 'string' || email.length === 0) {
    return fail(res, 400, 'email', 'email is required');
  }
  if (typeof password !== 'string' || password.length === 0) {
    return fail(res, 400, 'password', 'password is required');
  }

  const user = findUserByEmailStmt.get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    // Deliberately the same message for "no such user" and "wrong password"
    // so a caller can't use this endpoint to discover which emails exist.
    return fail(res, 401, 'credentials', 'email or password is incorrect');
  }
  return sendJSON(res, 200, { id: user.id, email: user.email, token: user.token });
}

// Returns the authenticated user, or writes a 401 and returns null.
function authenticate(req, res) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    fail(res, 401, 'authorization', 'missing or malformed Authorization header (expected "Bearer <token>")');
    return null;
  }
  const user = findUserByTokenStmt.get(match[1]);
  if (!user) {
    fail(res, 401, 'authorization', 'invalid token');
    return null;
  }
  return user;
}

// --- Habits ---------------------------------------------------------------

const insertHabitStmt = db.prepare('INSERT INTO habits (user_id, name, created_at) VALUES (?, ?, ?)');
const listHabitsStmt = db.prepare('SELECT id, name, created_at AS createdAt FROM habits WHERE user_id = ? ORDER BY id');
const findHabitOwnedStmt = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?');

async function handleCreateHabit(req, res, user) {
  const payload = await parseJsonBody(req, res);
  if (payload === null) return;
  const { name } = payload;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return fail(res, 400, 'name', 'name is required');
  }
  const info = insertHabitStmt.run(user.id, name, new Date().toISOString());
  return sendJSON(res, 201, { id: Number(info.lastInsertRowid), name });
}

function handleListHabits(req, res, user) {
  return sendJSON(res, 200, listHabitsStmt.all(user.id));
}

// Ownership boundary: a habit that exists but belongs to someone else is
// treated identically to one that doesn't exist at all (404), so a caller
// can't distinguish "not yours" from "not real" -- see README.
function requireOwnedHabit(res, habitId, user) {
  if (!/^\d+$/.test(habitId)) {
    fail(res, 400, 'habitId', 'habitId must be a positive integer');
    return null;
  }
  const habit = findHabitOwnedStmt.get(Number(habitId), user.id);
  if (!habit) {
    fail(res, 404, 'habitId', 'no habit with that id');
    return null;
  }
  return habit;
}

// --- Check-ins (the retry-safe write path) --------------------------------

const insertCheckinStmt = db.prepare(
  'INSERT INTO checkins (habit_id, date, created_at) VALUES (?, ?, ?)'
);
const findCheckinStmt = db.prepare('SELECT * FROM checkins WHERE habit_id = ? AND date = ?');
const listCheckinsStmt = db.prepare(
  'SELECT id, date, created_at AS createdAt FROM checkins WHERE habit_id = ? ORDER BY date DESC'
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handleCreateCheckin(req, res, user, habitId) {
  const habit = requireOwnedHabit(res, habitId, user);
  if (!habit) return;

  const payload = await parseJsonBody(req, res);
  if (payload === null) return;
  const { date } = payload;
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return fail(res, 400, 'date', 'date is required, format YYYY-MM-DD');
  }

  // Idempotency: the same (habit, date) check-in sent twice must not create
  // a second row. We check first for a clean 200 vs 201 distinction, and
  // the UNIQUE(habit_id, date) constraint is the real backstop if two
  // identical requests race each other.
  const existing = findCheckinStmt.get(habit.id, date);
  if (existing) {
    return sendJSON(res, 200, { id: existing.id, date: existing.date });
  }
  try {
    const info = insertCheckinStmt.run(habit.id, date, new Date().toISOString());
    return sendJSON(res, 201, { id: Number(info.lastInsertRowid), date });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      const row = findCheckinStmt.get(habit.id, date);
      return sendJSON(res, 200, { id: row.id, date: row.date });
    }
    throw err;
  }
}

function handleListCheckins(req, res, user, habitId) {
  const habit = requireOwnedHabit(res, habitId, user);
  if (!habit) return;
  return sendJSON(res, 200, listCheckinsStmt.all(habit.id));
}

// --- Router -----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'signup' && parts.length === 1) {
      return await handleSignup(req, res);
    }
    if (req.method === 'POST' && parts[0] === 'login' && parts.length === 1) {
      return await handleLogin(req, res);
    }

    // Everything below requires a valid Bearer token.
    if (parts[0] === 'habits') {
      const user = authenticate(req, res);
      if (!user) return; // 401 already sent

      if (req.method === 'POST' && parts.length === 1) {
        return await handleCreateHabit(req, res, user);
      }
      if (req.method === 'GET' && parts.length === 1) {
        return handleListHabits(req, res, user);
      }
      if (req.method === 'POST' && parts[2] === 'checkins' && parts.length === 3) {
        return await handleCreateCheckin(req, res, user, parts[1]);
      }
      if (req.method === 'GET' && parts[2] === 'checkins' && parts.length === 3) {
        return handleListCheckins(req, res, user, parts[1]);
      }
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('Unexpected error:', err);
    return sendJSON(res, 500, { error: 'internal server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Habit tracker listening on port ${PORT}`);
  });
}

module.exports = server;
