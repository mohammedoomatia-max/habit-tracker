// Automated check against the local-testable lines in "A reviewer checks"
// for the Final project brief. (Deployment/public-URL and "no secret
// committed" are checked by inspection, not by this script -- see README.)
//
// Run with: PASSWORD_PEPPER=test-pepper node test/acceptance.test.js

const fs = require('fs');
const path = require('path');

const TMP_DB = path.join(__dirname, '..', 'test.tmp.db');
if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB);
process.env.DB_PATH = TMP_DB;
process.env.PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || 'test-pepper';
process.env.NODE_ENV = 'test';

const server = require('../server');

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

async function signup(base, email, password) {
  const res = await fetch(`${base}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://localhost:${port}`;

  console.log('\n1) An unauthenticated request to a protected route returns 401\n');
  const noAuth = await fetch(`${base}/habits`);
  const noAuthBody = await noAuth.json();
  check('GET /habits with no Authorization header -> 401', noAuth.status === 401);
  check('401 names the field', noAuthBody.field === 'authorization');

  const badToken = await fetch(`${base}/habits`, { headers: { Authorization: 'Bearer not-a-real-token' } });
  check('GET /habits with a bogus token -> 401', badToken.status === 401);

  console.log('\n2) One user cannot read or write another user\'s rows\n');
  const alice = await signup(base, 'alice@example.com', 'correct-horse-1');
  const bob = await signup(base, 'bob@example.com', 'correct-horse-2');
  check('signup alice -> 201', alice.status === 201);
  check('signup bob -> 201', bob.status === 201);

  const aliceHabit = await fetch(`${base}/habits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.body.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Drink water' }),
  });
  const aliceHabitBody = await aliceHabit.json();
  check('alice creates a habit -> 201', aliceHabit.status === 201);

  const bobReadsAlice = await fetch(`${base}/habits/${aliceHabitBody.id}/checkins`, {
    headers: { Authorization: `Bearer ${bob.body.token}` },
  });
  check("bob reading alice's habit -> 404 (not 403, not 200)", bobReadsAlice.status === 404);

  const bobWritesAlice = await fetch(`${base}/habits/${aliceHabitBody.id}/checkins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.body.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-09-27' }),
  });
  check("bob writing to alice's habit -> 404, no row created", bobWritesAlice.status === 404);

  const aliceList = await fetch(`${base}/habits`, { headers: { Authorization: `Bearer ${alice.body.token}` } });
  const aliceListBody = await aliceList.json();
  const bobList = await fetch(`${base}/habits`, { headers: { Authorization: `Bearer ${bob.body.token}` } });
  const bobListBody = await bobList.json();
  check("alice's habit list contains her habit", aliceListBody.some((h) => h.id === aliceHabitBody.id));
  check("bob's habit list does not contain alice's habit", !bobListBody.some((h) => h.id === aliceHabitBody.id));

  console.log('\n3) One write path is retry-safe (same request twice leaves one row)\n');
  const first = await fetch(`${base}/habits/${aliceHabitBody.id}/checkins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.body.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-09-27' }),
  });
  const firstBody = await first.json();
  const second = await fetch(`${base}/habits/${aliceHabitBody.id}/checkins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.body.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-09-27' }),
  });
  const secondBody = await second.json();
  check('first check-in -> 201', first.status === 201);
  check('repeat check-in (same date) -> 200, not a new row', second.status === 200);
  check('repeat check-in returns the same id', firstBody.id === secondBody.id);

  const checkinsList = await fetch(`${base}/habits/${aliceHabitBody.id}/checkins`, {
    headers: { Authorization: `Bearer ${alice.body.token}` },
  });
  const checkinsListBody = await checkinsList.json();
  const sameDayCount = checkinsListBody.filter((c) => c.date === '2026-09-27').length;
  check('exactly one row exists for that habit+date', sameDayCount === 1);

  console.log('\n4) Error responses name what was wrong\n');
  const badSignup = await fetch(`${base}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
  });
  const badSignupBody = await badSignup.json();
  check('invalid email at signup -> 400', badSignup.status === 400);
  check('names the "email" field specifically', badSignupBody.field === 'email');

  const badDate = await fetch(`${base}/habits/${aliceHabitBody.id}/checkins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.body.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: 'not-a-date' }),
  });
  const badDateBody = await badDate.json();
  check('malformed date -> 400', badDate.status === 400);
  check('names the "date" field specifically', badDateBody.field === 'date');

  console.log('\n5) Logout revokes the token (bonus: not one of the original checks)\n');
  const carol = await signup(base, 'carol@example.com', 'correct-horse-3');
  const workingCheck = await fetch(`${base}/habits`, { headers: { Authorization: `Bearer ${carol.body.token}` } });
  check('token works before logout', workingCheck.status === 200);
  const logoutRes = await fetch(`${base}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${carol.body.token}` } });
  check('POST /logout -> 200', logoutRes.status === 200);
  const afterLogout = await fetch(`${base}/habits`, { headers: { Authorization: `Bearer ${carol.body.token}` } });
  check('the old token is rejected after logout -> 401', afterLogout.status === 401);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  fs.unlinkSync(TMP_DB);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});