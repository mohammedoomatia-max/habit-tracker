# Habit tracker

A small accounts-backed service: sign up, get a token, create habits,
check in on them. Built on Node's built-in `http` and `node:sqlite`
modules — there is nothing to `npm install`.

Live deployment: https://habit-tracker-1u6z.onrender.com
Source: https://github.com/mohammedoomatia-max/habit-tracker

## Prerequisites

- **Node.js v22.x** (developed and tested on v22.22.2). This is a hard
  requirement, not a suggestion — the service uses `node:sqlite`, which
  does not exist before Node 22. Run `node --version` to check.
- Nothing else. No database server to install, no `npm install` step,
  no Docker.

## Quickstart: clone to your first successful call

```bash
git clone https://github.com/mohammedoomatia-max/habit-tracker.git
cd habit-tracker
node server.js
```

You should see `Habit tracker listening on port 3000` (and a warning
about `PASSWORD_PEPPER` not being set — see below; it's safe to ignore
for a local test run).

In a second terminal:

```bash
curl -X POST http://localhost:3000/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"password123"}'
```

Expected response, `201 Created`:

```json
{ "id": 1, "email": "you@example.com", "token": "a9f3..." }
```

That's it — no config file to edit, no account to create anywhere else.
Everything past this point is reference material for the rest of the API.

## Environment variables

| Variable          | Required? | Default if unset      | Used for |
|--------------------|-----------|------------------------|----------|
| `PASSWORD_PEPPER`  | No — the service starts without it | `''` (empty string) | Mixed into every password hash (`db.js`). The service runs fine without it for local testing, but a real deployment should set a long random value — without a pepper, only the per-password salt protects stored hashes. A warning is printed on startup if it's missing (suppressed when `NODE_ENV=test`). |
| `PORT`             | No        | `3000`                 | The port the HTTP server listens on. Render and most hosts set this automatically — you don't need to set it yourself when deploying there. |
| `DB_PATH`          | No        | `./habits.db` (next to `server.js`) | Path to the SQLite database file. The test suite overrides this to a throwaway file so it never touches your real data. |
| `NODE_ENV`         | No        | unset                  | When set to `test`, suppresses the missing-pepper startup warning. Only used by `test/acceptance.test.js`. |

None of these are required for the server to **start** — that's
deliberate, so the quickstart above works with zero setup. `PASSWORD_PEPPER`
is the one you should set before using this for anything real; see
`.env.example`.

## Endpoints

Auth model: `POST /signup` and `POST /login` are public. Every other
endpoint requires `Authorization: Bearer <token>`, where `<token>` is
what `/signup` or `/login` returned.

---

### `POST /signup`
**Body:** `{ "email": string, "password": string }`
`email` must look like an email address. `password` must be 8+ characters.

| Status | Body | When |
|--------|------|------|
| `201 Created` | `{ id, email, token }` | account created |
| `400 Bad Request` | `{ error, field: "email" }` | email missing or not a valid address |
| `400 Bad Request` | `{ error, field: "password" }` | password missing or under 8 characters |
| `400 Bad Request` | `{ error, field: "body" }` | request body missing or not valid JSON |
| `409 Conflict` | `{ error, field: "email" }` | an account with that email already exists |

### `POST /login`
**Body:** `{ "email": string, "password": string }`

| Status | Body | When |
|--------|------|------|
| `200 OK` | `{ id, email, token }` | credentials correct |
| `400 Bad Request` | `{ error, field: "email" }` or `{ field: "password" }` | either is missing |
| `401 Unauthorized` | `{ error: "email or password is incorrect", field: "credentials" }` | wrong password, **or** no account with that email — deliberately the same response for both, so this endpoint can't be used to find out which emails are registered |

### `POST /habits`
**Auth required. Body:** `{ "name": string }`

| Status | Body | When |
|--------|------|------|
| `201 Created` | `{ id, name }` | habit created for the caller |
| `400 Bad Request` | `{ error, field: "name" }` | name missing or empty |
| `401 Unauthorized` | `{ error, field: "authorization" }` | missing/malformed `Authorization` header, or the token doesn't match any account |

### `GET /habits`
**Auth required. No body.**

| Status | Body | When |
|--------|------|------|
| `200 OK` | `[{ id, name, createdAt }, ...]` | only the caller's own habits — never another user's |
| `401 Unauthorized` | `{ error, field: "authorization" }` | as above |

### `POST /habits/:id/checkins`
**Auth required. Body:** `{ "date": "YYYY-MM-DD" }`
The write path designed to be retry-safe: sending the exact same
`(habit, date)` twice never creates a second row.

| Status | Body | When |
|--------|------|------|
| `201 Created` | `{ id, date }` | first check-in recorded for that date |
| `200 OK` | `{ id, date }` — **same `id` as the 201** | that habit already has a check-in for that date; nothing new was created |
| `400 Bad Request` | `{ error, field: "date" }` | date missing or not `YYYY-MM-DD` |
| `400 Bad Request` | `{ error, field: "habitId" }` | `:id` in the URL isn't a positive integer |
| `401 Unauthorized` | `{ error, field: "authorization" }` | missing/invalid token |
| `404 Not Found` | `{ error, field: "habitId" }` | no habit with that id belonging to *you* — this is also what you get if the habit belongs to someone else (see "Known limitations") |

### `GET /habits/:id/checkins`
**Auth required. No body.**

| Status | Body | When |
|--------|------|------|
| `200 OK` | `[{ id, date, createdAt }, ...]`, most recent first | habit exists and belongs to the caller |
| `400 Bad Request` | `{ error, field: "habitId" }` | `:id` isn't a positive integer |
| `401 Unauthorized` | `{ error, field: "authorization" }` | missing/invalid token |
| `404 Not Found` | `{ error, field: "habitId" }` | not found, or not yours |

## Known limitations — what this does not do

- **No pagination.** `GET /habits` and `GET /habits/:id/checkins` return
  every row in one response. Fine at the scale this was built for; would
  need `LIMIT`/`OFFSET` or a cursor for a large account.
- **Tokens never expire and cannot be revoked.** There's no logout
  endpoint. A leaked token is valid indefinitely.
- **No password reset or email verification.** Signup takes any string
  that looks like an email; nothing is sent to it.
- **No rate limiting.** `/signup` and `/login` can be hit as fast as the
  network allows — nothing here slows down a brute-force attempt.
- **CORS is wide open** (`Access-Control-Allow-Origin: *`), so any
  website's JavaScript can call this API in a browser. This is what
  lets `demo.html` (included in the repo) work as a local file with no
  server of its own — a real production deployment should restrict
  this to a specific known frontend origin instead.
- **Single SQLite file.** This works for one running instance; it does
  not support multiple server processes writing at once, and there's no
  read replica or horizontal scaling story.
- **The free Render tier sleeps after inactivity.** The first request
  after idle time can take 30–60 seconds while the instance wakes up —
  that's the platform, not a bug in the service.
- **No schema migrations.** `createSchema()` only ever adds tables/indexes
  that don't exist yet; changing a column means editing `db.js` and
  recreating the database file by hand.

## Running the tests

```bash
node test/acceptance.test.js
```

Builds its own temporary database and checks: 401 on missing/invalid
auth, cross-user ownership isolation (a real two-account test), the
retry-safe check-in path, and that every 400 names a specific field.
18 checks, all passing as of this README.

## Trying it against the live deployment

Either substitute `https://habit-tracker-1u6z.onrender.com` for
`http://localhost:3000` in the curl command above, or open `demo.html`
(in this repo) directly in a browser — it's a small page with buttons
for each endpoint, already pointed at the live URL.

## Deployment

Deployed with [Render](https://render.com) (free tier):

1. Push this repo to GitHub (public).
2. Render: New → Web Service → connect the repo.
3. Build command: `echo "no build step needed"` (Render requires
   something here even though there's nothing to install).
4. Start command: `node server.js`
5. Environment variable: `PASSWORD_PEPPER` = a long random string, e.g.
   from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
6. Deploy. `PORT` is set automatically by Render — no action needed.
