# To-Do

A to-do list on a clock. Tasks show up as dots around a live analog clock; tap an hour to see what's due then, long-press an hour to add a task there. Soft-blue neumorphism + glassmorphism UI with light, dark and auto themes, daily/weekly progress, a focus timer, friends and task sharing, and Web Push reminders 10 minutes before a task.

| Folder | Stack |
|---|---|
| [`client/`](client/) | React + Vite + TypeScript |
| [`server/`](server/) | Python 3.13, Django 5.2 + DRF, PostgreSQL (psycopg 3), Web Push via pywebpush, managed with uv |

## Getting Started

### Backend (`server/`)
```bash
cd server
uv sync
cp .env.example .env        # fill in SECRET_KEY + DB credentials
uv run python scripts/generate_vapid_keys.py   # paste the output into .env
createdb to_do_app
uv run python manage.py migrate
uv run python manage.py runserver   # http://127.0.0.1:8000
```

Reminders are sent by a separate job (it checks every 20 s; `.claude/launch.json` has it as "reminders"). Locally, run it in a second terminal:
```bash
uv run python manage.py send_reminders --loop
```

Tests: `uv run python manage.py test`

### Frontend (`client/`)
```bash
cd client
npm install
npm run dev   # http://localhost:5173 (proxies /api to Django)
```

Open the app, create an account, and answer the first-visit question to get the guided tour. Turn on reminders with the bell.

## Accounts

Same login/logout model as afm_sys, adapted for a Vite frontend (Django sets the cookie itself):

- **Email + password.** Passwords need 12+ characters with an uppercase letter, a lowercase letter, a digit and a symbol.
- **Access token** (30 min) is returned in the response body and kept only in memory, never in localStorage.
- **Refresh token** (7 days) is an httpOnly cookie scoped to `/api/auth/`. Every refresh rotates it and blacklists the old one; logout blacklists it and clears the cookie.
- On a 401 the client refreshes once and retries; if that fails it returns to the login screen.
- 5 wrong passwords lock the account for 15 minutes; login and sign-up are rate-limited. Login/refresh/logout reject requests from other websites' origins.
- Unlike afm_sys there's a public sign-up page, since this isn't an admin-managed system.

### Email codes (verification + new-device sign-in)

- **Email check while typing** (`/api/auth/check-email/`, also enforced on sign-up and email change): valid format, the domain has mail servers (MX lookup, cached a day), no throwaway inboxes, and a one-tap fix for typos like `gmial.com`.
- **Verify your email**: sign-up emails a 6-digit code; the app shows a "Verify your email" screen until it's entered (task/friend APIs answer 403 until then). Changing your email in Profile asks for a code again. Accounts made before this existed were marked verified.
- **New-device sign-in (2FA)**: the right password on a browser the account hasn't used returns `{two_factor_required, challenge}` instead of a session and emails a code. Entering it signs you in and remembers the browser (httpOnly `device_id` cookie, 180 days). Profile → Trusted devices lists and removes them.
- Codes: only an HMAC hash is stored, 10-minute expiry, 5 tries, a new code cancels the old one, "Send again" after 60 s, at most 5 per hour.
- **Designs**: all emails share one layout (`server/apps/users/templates/emails/base.html`: brand, card, footer, dark mode for Apple Mail/iOS) with a plain-text twin for each. Code emails stay link-free. While developing, open http://127.0.0.1:8000/dev/emails/verify/ (or `login`, `welcome`; add `?format=text`) to see them (DEBUG only).
- **Welcome email**: sent once per account, the first time it's signed in with a confirmed email (right after sign-up verification; existing accounts get it at their next login). `APP_URL` sets its "Open To-Do" button.
- **Sending**: Gmail SMTP when `EMAIL_HOST_USER` + `EMAIL_HOST_PASSWORD` (a Google App Password) are set in `server/.env`; otherwise emails are written to `server/.dev-emails/` so you can read codes while developing.

The user record also stores the device's time zone (updated automatically, used for reminder text), whether reminders are on, and `tutorial_seen` (set once the first-visit question is answered or the tour ends, so it never shows again on any device).

## Overdue

Unfinished tasks from earlier days appear at the top of **Today** under "Overdue" (oldest first). Each has **Today →** (moves it to today at the same time, or the next full hour if that time has passed), the usual circle to mark it done, and **Move all to today** when there are several. Progress shows how many are overdue. The list comes from `GET /api/tasks/?overdue_before=<start of today>`.

## Priority

High / Medium / Low isn't just a label: within the same time (and in Anytime) tasks are listed High → Low, high-priority tasks get a bigger ringed dot on the clock, Progress shows "By priority this week", and a high-priority reminder is sent with high urgency and stays on screen until dismissed.

## Deleting and restoring

Deletes are **soft first, permanent later**:

- **Tasks**: deleting (after the 5-second Undo) moves a task to Profile → **Recently deleted** for 7 days, where it can be restored or erased now.
- **Accounts**: Profile → Delete account logs you out everywhere, hides you from friends and search and stops reminders. Logging in within 30 days offers **Restore my account** (for a verified email it also needs the emailed sign-in code). Friends and tasks come back with it. The email stays reserved meanwhile.
- The daily clean-up (`manage.py prune` / `/api/cron/prune/`) erases accounts and tasks past those windows for good. The security log keeps "deleted"/"restored" rows for 180 days.
- In code, `User.objects` and `Task.objects` already skip deleted rows; use `all_objects` only where deleted ones are wanted (admin, restore, clean-up).

## Admin

Make yourself an admin with `uv run python manage.py createsuperuser` (or set `is_staff` on an existing account in the Django admin). Admins get an **Admin** tab in the app (on phones: Profile → Admin dashboard) with user counts on top and two separate tables:

- **Users**: search by name or email, filter by status and verified email, sort by name, tasks, joined or last login, and page through (10–100 rows). Click a row for the account drawer (details, recent activity, ban/unban).
- **Activity log**: every sign-up, login and logout; search by email or IP, filter by event and period (24 h / 7 / 30 days), sort by time, event or account. "See all in the log" in an account drawer opens it filtered to that person. The same data is available from the `/api/admin/` endpoints below and the Django admin at `/admin/`.

- **Ban** sets the account inactive, records when and why, and revokes every session at once: the user's open app stops working on its next request and they can't log back in ("This account has been suspended."). Admin accounts and your own account can't be banned. **Unban** restores access.
- **Auth log** (`AuthEvent`): one row per account creation, login and logout. The IP address is stored for logins only. The same events are written to the server log (`apps.users.auth`).

## Friends and sharing

Find people, send friend requests, and send friends **copies** of your tasks with an optional note. Nobody can ever see your list: a share is a snapshot, and it waits in the recipient's "Sent to you" inbox until they add it (all or some) or dismiss it. If an added task lands at the same time as one they already have, both are kept and they're told. If a shared task's day has already passed for them, it's added under Anytime. **Add & remind** (the default in "Share with a friend") skips the inbox: the task goes straight into the friend's list with a reminder, marked "from Mia", and stays linked: when you move, rename or delete yours, their copy follows and they're told. They can tick it done or change its reminder freely; editing its time or title makes it their own copy. Unfriending unlinks everything. Anyone can turn this off in Profile ("Friends can add tasks to my list"); then it lands in their inbox instead (`POST /api/social/remind/`).

People with notifications on also get a push (sent in the background, tapping it opens Friends) when someone sends them a friend request, accepts theirs, or sends them tasks.

## Timer

A countdown timer (quick picks 1–60 min, or exact minutes and seconds) shown as a dial that empties as time runs down. It can be linked to a task and offers "Mark done" when time's up, with a soft chime and, if the page is in the background and notifications are allowed, a system notification. It keeps running across screens (the header and the browser tab show the time left), survives a reload, and is stored only on this device (cleared on logout).

## API

| Method | Path | |
|---|---|---|
| POST | `/api/auth/register/` · `/api/auth/login/` | Start a session: `{access, user}` + refresh cookie |
| POST | `/api/auth/refresh/` · `/api/auth/logout/` | Rotate / end the session (cookie) |
| GET / PATCH | `/api/auth/me/` | Profile: name, email, time zone, reminders, tutorial_seen |
| DELETE | `/api/auth/me/` | Delete your own account: `{password}`. Soft delete: logged out everywhere, hidden, restorable by logging in for 30 days |
| POST | `/api/auth/change-password/` | `{old_password, new_password}` |
| POST | `/api/auth/check-email/` | `{email}` → `{ok, message, suggestion, checks: {format, real_inbox, receives_mail}}` |
| GET / DELETE | `/api/tasks/trash/` | Recently deleted tasks (7 days) / empty them |
| POST · DELETE | `/api/tasks/<id>/restore/` · `/api/tasks/<id>/purge/` | Bring a deleted task back / erase it now |
| POST | `/api/auth/login/verify/` · `/api/auth/login/resend/` | New-device sign-in: `{challenge, code}` → session + trusted-device cookie |
| POST | `/api/auth/verify-email/` · `/api/auth/verify-email/resend/` | Confirm your email: `{code}` |
| GET / DELETE | `/api/auth/devices/` · `/api/auth/devices/<id>/` | Trusted devices |
| POST | `/api/cron/prune/` | Daily clean-up (header `X-Cron-Secret`); same as `manage.py prune` |
| GET | `/api/admin/stats/` | Admin: total, active, banned, new in 7 days, logins in 24 h |
| GET | `/api/admin/users/?search=&status=active\|banned&page=` | Admin: users with task counts, last login and IP |
| GET | `/api/admin/users/<id>/` | Admin: one user plus their last 50 auth events |
| POST | `/api/admin/users/<id>/ban/` · `.../unban/` | Admin: `{reason}` to ban; unban restores |
| GET | `/api/admin/auth-events/?user=&kind=signup\|login\|logout` | Admin: the auth log |
| GET | `/api/social/users/?q=` | Search people by name or exact email (2+ chars, max 20; emails partly hidden) |
| GET | `/api/social/friends/` | Your friends, plus incoming and outgoing requests |
| POST | `/api/social/friends/requests/` | `{user_id}`: ask to be friends (accepts instead if they already asked you) |
| POST / DELETE | `/api/social/friends/<id>/accept/` · `/api/social/friends/<id>/` | Accept; decline / cancel / unfriend |
| GET / POST | `/api/social/shares/` | What friends sent you; send `{recipient_id, task_ids, message}` (friends only, your own tasks) |
| POST | `/api/social/shares/<id>/add/` · `.../dismiss/` | Copy all (or `{item_ids}`) into your list; same-time clashes are kept and reported |
| GET | `/api/social/summary/` | Badge counts: pending requests + new shares |
| GET | `/api/tasks/?start=<iso>&end=<iso>&anytime=1` | Tasks due in `[start, end)`, plus tasks with no time |
| POST | `/api/tasks/` | Create |
| PATCH / DELETE | `/api/tasks/<id>/` | Update / delete |
| GET | `/api/push/vapid-public-key/` | Key the browser subscribes with |
| POST / DELETE | `/api/push/subscribe/` | Add / remove this browser's push subscription |
| POST | `/api/push/send-due/` | Send due reminders; needs header `X-Cron-Secret: $CRON_SECRET` |

Everything except the VAPID key and the cron endpoint requires a logged-in user, and users only ever see their own tasks.

## Deploying (free tier)

**Vercel** (the app) → forwards `/api/*` to **Render** (Django) → **Supabase** (Postgres). Email goes through **Brevo**, reminders and clean-up are triggered by **cron-job.org**. All free.

Why these: Render's free plan blocks outgoing email on ports 25/465/587, so email uses Brevo on port 2525. Neon's free plan has 100 compute-hours a month, which a once-a-minute reminder check would use up; Supabase has no compute-hour cap.

1. **Supabase**: new project → Project Settings → Database → *Connection string* → **Session pooler** (the direct one is IPv6-only). Copy it, with your database password filled in, as `DATABASE_URL`.
2. **Brevo**: free account → Senders, domains → add and verify the address emails come *from* → SMTP & API → SMTP keys → create one. `EMAIL_HOST_USER` = the SMTP login shown there, `EMAIL_HOST_PASSWORD` = the key, `DEFAULT_FROM_EMAIL` = `To-Do <the verified address>`.
3. **VAPID keys** for production: `uv run python scripts/generate_vapid_keys.py` (new ones, not your local ones).
4. **Render**: New → Blueprint → this repo (uses `render.yaml`). Fill in `DATABASE_URL`, the Brevo values, the VAPID values, `VAPID_SUBJECT` (`mailto:you@…`), and for now `TRUSTED_FRONTEND_ORIGINS` / `APP_URL` = `https://placeholder.vercel.app`. The build runs migrations. Note the URL, e.g. `https://to-do-api.onrender.com`, and check `…/api/health/` answers `{"ok": true}`.
5. **Vercel**: put the Render URL into `client/vercel.json` (replace `YOUR-RENDER-APP`), commit and push. New Project → this repo → Root Directory `client` → Deploy. No environment variables needed.
6. Back in **Render** → Environment: set `TRUSTED_FRONTEND_ORIGINS` and `APP_URL` to the real Vercel URL → save (it redeploys).
7. **cron-job.org** (two jobs, method POST, header `X-Cron-Secret` = Render's generated `CRON_SECRET`):
   - every minute: `https://<render>/api/push/send-due/` (reminders; also keeps the free server awake)
   - daily: `https://<render>/api/cron/prune/` (clean-up)
8. **Make yourself admin** (Render's free plan has no shell, so from your Mac): sign up in the live app, then
   `cd server && DATABASE_URL="<supabase url>" uv run python manage.py make_staff you@gmail.com` (a `DATABASE_URL` always wins over the local `DB_*` settings).
9. **iPhone**: push only works after "Add to Home Screen".

Production settings live in `server/config/settings/production.py` (HTTPS only, HSTS, secure cookies, no CORS because the app and `/api` share the Vercel domain).
