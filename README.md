# Habit tracker

A small accounts-backed service: sign up, get a token, create habits,
check in on them. Built on Node's built-in `http` and `node:sqlite`
modules — no external dependencies. Requires **Node.js 22+**.

## Endpoints

| Method | Path                       | Auth? | Success       | Notes |
|--------|----------------------------|-------|---------------|-------|
| POST   | `/signup`                  | no    | `201 Created` | `{ email, password }` → `{ id, email, token }` |
| POST   | `/login`                   | no    | `200 OK`      | `{ email, password }` → `{ id, email, token }` |
| POST   | `/habits`                  | yes   | `201 Created` | `{ name }` |
| GET    | `/habits`                  | yes   | `200 OK`      | only the caller's own habits |
| POST   | `/habits/:id/checkins`     | yes   | `201`/`200`   | `{ date: "YYYY-MM-DD" }`; see "Retry-safe write path" |
| GET    | `/habits/:id/checkins`     | yes   | `200 OK`      | only if the caller owns habit `:id` |

Authenticated routes require `Authorization: Bearer <token>`, the token
returned by `/signup` or `/login`.

## Auth: unauthenticated requests get 401

Any request to `/habits...` without a valid `Authorization: Bearer <token>`
header gets:

```json
{ "error": "missing or malformed Authorization header (expected \"Bearer <token>\")", "field": "authorization" }
```

with status `401`. An invalid or unrecognized token gets the same status
with `"invalid token"`.

## Ownership: one user cannot reach another user's rows

Every habit and check-in belongs to exactly one user (`habits.user_id`).
Every read or write to `/habits/:id...` looks up the habit **scoped to
the authenticated user**:

```sql
SELECT * FROM habits WHERE id = ? AND user_id = ?
```

If the habit doesn't exist, *or* exists but belongs to someone else,
this query returns nothing either way — and the API responds `404` in
both cases. That's deliberate: returning `403` for "exists but isn't
yours" would let a caller enumerate other users' habit IDs by watching
which ones come back `403` vs `404`. Treating both as `404` leaks
nothing.

`test/acceptance.test.js` proves this: it creates two accounts, has one
try to read and write the other's habit, and checks both come back
`404` with no row created.

## Retry-safe write path: check-ins

Checking in on a habit for a given day is the write that must survive a
retry. A check-in is identified by `(habit_id, date)`:

```sql
CREATE TABLE checkins (
  ...
  UNIQUE(habit_id, date)
);
```

`POST /habits/:id/checkins` first looks for an existing check-in with
that date and returns it (`200`) if found. If two identical requests
race each other (e.g. a client retries before the first response
arrives), the `UNIQUE(habit_id, date)` constraint is the real backstop:
the second `INSERT` fails, the handler catches that specific failure,
and re-reads the row that already exists — so the caller still gets a
clean `200` with the existing id, never a duplicate row and never a raw
database error. The same date sent any number of times always leaves
exactly one row and returns the same `id`.

## Errors name what was wrong

Every `400` response is `{ "error": "<message>", "field": "<field>" }`,
naming the specific field, e.g.:

```json
{ "error": "date is required, format YYYY-MM-DD", "field": "date" }
```

so a caller can act on the response without reading this repo's source.

## No secret is committed to this repository

Password hashing mixes in a pepper from `PASSWORD_PEPPER`, read from the
environment (`process.env.PASSWORD_PEPPER`) — never hardcoded. `.env` is
in `.gitignore`; only `.env.example`, with a placeholder, is committed.
When deploying, set the real value as an environment variable on the
hosting platform (see below), not in a file that gets pushed to GitHub.

## Running it locally

```bash
cp .env.example .env
# edit .env and set a real PASSWORD_PEPPER
node server.js
# Habit tracker listening on port 3000
```

## Automated acceptance check

```bash
node test/acceptance.test.js
```

Builds its own temporary database and checks every locally-testable line
in the brief's "A reviewer checks" list: 401 on missing auth, cross-user
isolation (with a real two-account test), the retry-safe check-in path,
and named error fields. (The remaining two checks — reachable at a
public URL, and no secret in the repo — are verified by visiting the
deployed URL and by inspecting this repo, respectively.)

## Deployment

Deployed with [Render](https://render.com) (free tier, no credit card):

1. Push this repo to GitHub (public).
2. On Render: New → Web Service → connect this repo.
3. Build command: (leave blank — no dependencies to install)
4. Start command: `node server.js`
5. Add an environment variable: `PASSWORD_PEPPER` = (a long random string,
   e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
6. Deploy. Render gives a public URL like `https://habit-tracker-xxxx.onrender.com`.

The service reads `PORT` from the environment automatically (Render sets
it), so no changes are needed for that.
