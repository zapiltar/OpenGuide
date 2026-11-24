# OpenGuide Bar server

The website and API behind Bar Mode, which shows a bar's menus, events and specials on the TVs running OpenGuide.
It runs on Cloudflare's free plan as one Worker, with D1 for data and R2 for images. The design is in
[`docs/bar-mode-plan.md`](../docs/bar-mode-plan.md).

## Run it locally

Requires Node.js 20 or newer. Nothing here needs a Cloudflare account.

```bash
npm install
```

```bash
npm test
```

To run the Worker at http://localhost:8787, copy `.dev.vars.example` to `.dev.vars`. Its `SETUP_CODE` is what the
setup page asks for when you create the owner account at http://localhost:8787/admin/#/setup. Then create the
local database and start it:

```bash
npm run migrate:local
```

```bash
npm run dev
```

## API

## Accounts

Invite-only. The **owner** is the super user: they see and manage every bar, add bars, and invite each bar's
manager. Their account comes from the setup page (`/admin/#/setup`), which needs the `SETUP_CODE` secret and
closes once an owner exists. The same code also lets the owner set a new password if they forget theirs.

Everyone else joins a bar through a one-time **invite link** (valid 7 days) that the owner or the bar's
**manager** makes on the bar's People page and passes on. Managers can invite and remove staff and make
**password reset links** for them (valid 3 days). Staff manage the bar's content. Nothing is emailed, so links
are passed on by text or email by whoever made them.

Passwords are stored as salted PBKDF2-SHA256 hashes. Sessions last 30 days in a Secure, HttpOnly,
SameSite=Lax cookie, and are stored only as hashes. An account locks for 15 minutes after 10 wrong passwords,
and an address after 30 wrong tries in 15 minutes. Resetting or changing a password signs out everywhere else.

## API

Admin routes need a signed-in session. Writes take JSON, and must come from the site itself.

| Route | What it does |
|-------|--------------|
| `POST /api/auth/login`, `POST /api/auth/logout` | Sign in with `{email, password}`; sign out |
| `GET, POST /api/auth/setup` | Whether setup is needed; create the owner, or reset the owner's password, with `{code, email, password}` |
| `GET, POST /api/auth/invite/:token` | What an invite is for; join with `{email, password, name}` (an existing account just needs its password) |
| `GET, POST /api/auth/reset/:token` | Whose reset link it is; set `{password}` |
| `POST /api/admin/account/password` | Change your own password with `{current, password}` |

| `GET /api/admin/me` | Who you're signed in as, and whether you're the owner |
| `GET, POST /api/admin/venues` | List bars you can manage; add a bar (owner) |
| `GET, PATCH, DELETE /api/admin/venues/:id` | A bar's details and branding (`displayName`, `logo`, `timezone`). Renaming and deleting are owner only |
| `GET /api/admin/venues/:id/staff` | The bar's people and unused invites (owner or manager) |
| `POST /api/admin/venues/:id/invites`, `DELETE .../invites/:id` | Make an invite link with `{role}` ("staff", or "manager" for the owner); cancel one |
| `DELETE /api/admin/venues/:id/staff/:email`, `POST .../staff/:email/reset` | Remove someone; make a password reset link for them |
| `GET, POST /api/admin/venues/:id/screens` | Linked TVs; link one with `{code, name}` |
| `PATCH, DELETE /api/admin/venues/:id/screens/:sid` | Rename or unlink a TV |
| `POST /api/admin/venues/:id/images` | Upload an image (PNG, JPEG, WebP or GIF, up to 5 MB) as the raw body; returns its `key` |
| `GET, POST /api/admin/venues/:id/{menus,events,specials}` | List or add |
| `GET, PUT, DELETE /api/admin/venues/:id/{menus,events,specials}/:itemId` | Read, replace or delete one |

The TV app uses these:

| Route | What it does |
|-------|--------------|
| `POST /api/tv/pair` | Starts linking: returns a `code` to show on screen and a `secret` to keep |
| `POST /api/tv/pair/status` | With `{code, secret}`: `waiting`, then `linked` with the screen `token` (once) |
| `GET /api/tv/feed` | With `Authorization: Bearer <token>`: everything the TV shows. Supports `If-None-Match`. A `401` means the TV was unlinked |
| `POST /api/tv/unlink` | With the token: the TV unlinked itself, so its screen is removed |
| `GET /img/:key` | An uploaded image |

A special's `schedule` is either `{"type": "once", "start": ms, "end": ms}` or
`{"type": "weekly", "days": [1, 2, 3, 4, 5], "start": "16:00", "end": "19:00"}`, with days from 0 (Sunday) to
6 and times in the bar's time zone. An end before the start runs past midnight. `timeoutSeconds` is 5 to 600
(30 for banners and 15 for takeovers if left out), or `null` to keep a banner up until the special ends.
The feed sends each special's start and end times for the next week, already worked out in the bar's time zone.

## Deploy

1. Create the database and image bucket, then put the database id in `wrangler.jsonc`:

```bash
npx wrangler login
```

```bash
npx wrangler d1 create openguide-bar
```

```bash
npx wrangler r2 bucket create openguide-bar-images
```

2. Set the setup code, a long random string only you know, then create the tables and deploy:

```bash
npx wrangler secret put SETUP_CODE
```

```bash
npm run migrate:remote
```

```bash
npm run deploy
```

3. Open `/admin/#/setup` on the Worker's address, enter the setup code, and create your owner account. Then
   add each bar and send its manager the invite link.

`.dev.vars` can also set `DEV_ADMIN_EMAIL` to skip signing in while developing. Never set it on the deployed
Worker; it's only honoured on localhost anyway.

## Admin site

The admin site is at `/admin/`: plain HTML, CSS and JavaScript in `public/admin`, with no build step. It
works on a phone, since staff will often update specials from behind the bar. Once signed in, you see the bars
you can manage, each with these pages:

- **Specials:** add, edit, pause and delete, with each one's next showing.
- **Menus:** type items in by section, or upload a picture of the menu.
- **Events:** upcoming and past.
- **Screens:** link a TV by its code, rename it, see whether it's online, unlink it.
- **Name & logo:** what the TVs show in place of OpenGuide, and the bar's time zone.
- **People** (owner and the bar's managers): invite links, password reset links, and removing people.

Every time on the site is in the bar's time zone. `public/shared/schedule.js` holds the time zone rules, and
both the Worker and the site use that same file.

## Not done yet

- Images that are replaced, or whose item is deleted, stay in R2. They're removed when their bar is deleted.
