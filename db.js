const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'habits.db');

// A pepper mixed into every password hash. Read from the environment, never
// hardcoded -- see README "No secrets in the repo".
const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || '';
if (!process.env.PASSWORD_PEPPER && process.env.NODE_ENV !== 'test') {
  console.warn('Warning: PASSWORD_PEPPER is not set. Set it in your environment before deploying.');
}

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON;');
  createSchema(db);
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- The retry-safe write path: a check-in is identified by (habit_id, date).
    -- The same check-in request sent twice hits this constraint and the
    -- second attempt returns the first row instead of creating a new one.
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL REFERENCES habits(id),
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(habit_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_habits_user_id ON habits(user_id);
  `);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password + PASSWORD_PEPPER, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, derivedExpected] = stored.split(':');
  const derived = crypto.scryptSync(password + PASSWORD_PEPPER, salt, 64).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(derivedExpected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  DB_PATH,
  openDb,
  createSchema,
  hashPassword,
  verifyPassword,
  generateToken,
};
