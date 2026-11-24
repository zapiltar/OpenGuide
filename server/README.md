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

To run the Worker at http://localhost:8787, copy `.dev.vars.example` to `.dev.vars` and put your email in it.
Admin requests from localhost are then signed in as that email. Then create the local database and start it:

```bash
npm run migrate:local
```

```bash
npm run dev
```

## API

Admin routes need a Cloudflare Access sign-in, or the `.dev.vars` email on localhost. Writes take JSON.

| Route | What it does |
|-------|--------------|
| `GET /api/admin/me` | Who you're signed in as, and whether you're the owner |
| `GET, POST /api/admin/venues` | List bars you can manage; add a bar (owner) |
| `GET, PATCH, DELETE /api/admin/venues/:id` | A bar's details and branding (`displayName`, `logo`, `timezone`). Renaming and deleting are owner only |
| `GET, POST /api/admin/venues/:id/staff`, `DELETE .../staff/:email` | Who can manage the bar (owner only) |
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

2. Set `OWNER_EMAILS` in `wrangler.jsonc`, then create the tables and deploy:

```bash
npm run migrate:remote
```

```bash
npm run deploy
```

3. In the Cloudflare dashboard, under **Zero Trust > Access > Applications**, add a self-hosted application
   for the Worker's address covering the paths `/admin` and `/api/admin`. Allow the owner's and staff's emails
   with a one-time PIN login. Copy the application's **AUD tag** and your **team domain** into `ACCESS_AUD`
   and `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc`, then deploy again.

Never set `DEV_ADMIN_EMAIL` on the deployed Worker. It's only honoured on localhost anyway.

## Admin site

The admin site is at `/admin/`: plain HTML, CSS and JavaScript in `public/admin`, with no build step. It
works on a phone, since staff will often update specials from behind the bar. Once signed in, you see the bars
you can manage, each with these pages:

- **Specials:** add, edit, pause and delete, with each one's next showing.
- **Menus:** type items in by section, or upload a picture of the menu.
- **Events:** upcoming and past.
- **Screens:** link a TV by its code, rename it, see whether it's online, unlink it.
- **Name & logo:** what the TVs show in place of OpenGuide, and the bar's time zone.
- **Staff** (owner only): who else can manage the bar.

Every time on the site is in the bar's time zone. `public/shared/schedule.js` holds the time zone rules, and
both the Worker and the site use that same file.

## Not done yet

- Images that are replaced, or whose item is deleted, stay in R2. They're removed when their bar is deleted.
