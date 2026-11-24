# Bar Mode plan

Lets a bar link the TVs running OpenGuide to a venue and show its menus, events and specials, managed from a
website hosted free on Cloudflare.

## Decisions so far

- **Accounts:** you create each bar on the website and invite its staff by email. No public sign-up.
- **Specials on screen:** a banner by default, so the game stays visible. Each special can switch to a short
  full-screen takeover instead.
- **App:** one app for everyone. Bar Mode stays hidden until a TV is linked to a bar in Settings.
- **Hosting:** Cloudflare's free plan. The server code lives in this repo under `server/`, with no secrets in it.

## How it fits together

```
 Bar staff ──► Admin site ──┐
 (browser)   (signed in     │      ┌──────────── one Cloudflare Worker ───────────┐
              with their    ├────► │  /admin      admin pages (static files)      │
              own account)  │      │  /api/admin  edit venues, menus, specials... │
                            │      │  /api/tv     pairing + the TV's feed         │
 TV running OpenGuide ──────┘      │  /img        menu and special images         │
 (polls every ~10 min)             └───────┬──────────────────────┬───────────────┘
                                           │                      │
                                     D1 (database)          R2 (images)
```

- **One Worker** serves the admin pages and both APIs, which makes it a single thing to deploy. Cloudflare now
  points new projects at Workers with static files rather than Pages.
- **Accounts are the site's own, invite-only.** The owner (super user) sees every bar and invites each bar's
  manager with a one-time link; managers invite their staff. Each person only sees their own bars. This
  replaced the first plan of Cloudflare Access, which needed every email typed into Cloudflare and capped at
  50 people. Details are in [`server/README.md`](../server/README.md#accounts).
- **Each TV downloads its bar's whole schedule ahead of time** and runs overlays from its own clock. If the
  internet drops, specials still start on time, and polling stays far under the free limits: about 144 requests
  a day per TV, so 100 TVs is around 14,000 of the 100,000 a day allowed.

## What the website manages

| Item | What staff set |
|------|----------------|
| **Bar** (you only) | Name, time zone, staff emails |
| **Branding** | Display name and logo the linked TVs show in place of "OpenGuide" (see Branding below) |
| **Screens** | Linked TVs with a name ("Bar left"), last seen, app version, unlink |
| **Menus** | Either an uploaded image or a list of sections and items with prices and descriptions |
| **Events** | Title, description, image, date and time (trivia night, a big game) |
| **Specials** | Title, text, image, when it runs (one-off, or weekly on chosen days between two times), banner or takeover, **timeout** (how long it stays on screen each time it appears, for banners and takeovers alike: 5 seconds to 10 minutes, or "until the special ends" for banners), how often to repeat while it's on |

Each item can be shown on all of a bar's screens or only on the screens chosen for it.

## Data (D1 tables)

- `venues`: id, name, time zone
- `staff`: email, venue, role (`owner` for you across all bars, `staff` for one bar)
- `screens`: id, venue, name, token hash, last seen, app version
- `pairings`: short code, device id, expiry (10 minutes)
- `menus`, `events`, `specials`: venue, content fields, image key, which screens, updated time
- `venues.feed_version`: goes up on every edit so TVs can ask "anything new?" cheaply, using an ETag

## TV API

1. **Pairing.** In **Settings > Bar mode > Link to a bar**, the TV asks for a code and shows it on screen, such as
   `K7Q-4MD`. Staff type that code on the website's Screens page and name the screen. The TV, which checks every
   few seconds while showing the code, then receives a long-lived screen token. Only a hash of the token is
   stored.
2. **Feed.** `GET /api/tv/feed`, sent with the token and the last ETag, returns `304` when nothing has changed.
   Otherwise it returns the bar's menus, events and specials, plus the server's current time. **The server works
   out every special's start and end times for the next 7 days in the bar's time zone**, so all the weekly
   schedule and time zone rules live in one tested place, and the app only compares times.
3. **Images** come from `/img/<key>` with long cache headers. Coil, which the app already uses, caches them on
   disk.
4. Each feed request records when the screen was last seen and its app version, so the Screens page can show
   which TVs are online.

## Android app changes

- **Settings > Bar mode:** link, show the linked bar and screen name, unlink. The setting is always there, but nothing
  else changes until the TV is linked.
- **`BarFeed` (new, in `data/`):** fetches on start and every 10 minutes, saves the last feed to a file so it
  works offline after a restart, and corrects for a wrong TV clock using the server's time.
- **Bar Channel:** a virtual channel at the top of the lineup, like the existing Guide Channel
  (`GUIDE_CHANNEL`), that cycles through the menus, upcoming events and today's specials. It is useful on a TV
  that isn't showing a game.
- **Special overlays (new, in `ui/`):** when a special starts, a banner slides in at the **top** of the screen
  (the channel banner already uses the bottom), hides itself when its timeout runs out, and comes back at the
  chosen repeat interval while the special lasts. Takeover specials cover the screen until their timeout runs
  out and then return to the channel. Defaults are 30 seconds for a banner and 15 for a takeover. A takeover
  never stays up longer than 10 minutes, so a mistake can't hide the game all night. Back dismisses either one
  early. They show over full-screen video and the guide, but not over Settings.
- **Branding:** once linked, the app uses the bar's name and logo from the feed everywhere it draws its own
  name: the top bar, the loading screen, the Bar Channel and the special banners. Unlinking brings back
  "OpenGuide". The logo is cached like other images, so it still shows offline.
- The server address is a build setting, like the existing `updateApi`, so other builds can point at their own
  server.

## Build order

1. **Cloudflare setup (you):** create a free Cloudflare account, then run `npx wrangler login` once on this PC.
   I can't create accounts for you.
2. **Server foundation:** Worker, D1 schema and pairing, with tests that run locally through `wrangler dev`
   before anything is deployed.
3. **Admin website:** bars, staff, screens, menus, events and specials, plus image upload to R2, and invite-only
   accounts.
4. **Feed API:** schedule expansion with tests for weekly repeats, specials that run past midnight, and daylight
   saving changes.
5. **Android: pairing, `BarFeed` and Bar Channel.**
6. **Android: special overlays.**
7. **Release** as the next version, with a README section for bars.

## Branding and the home screen

Inside the app, the bar's name and logo can replace OpenGuide's at any time, straight from the website. **The
name and icon in the TV's app launcher can't.** Android and Fire OS read those from the installed APK, and an
app can't swap in a downloaded image there. The ways around that, if bars want it:

- **A custom build per bar:** the same app with the bar's name, icon and a different app id, built from a
  small config file. It's simple, but each bar needs its own APK and its own update releases.
- **A few built-in icon styles** the app can switch between (Android's activity-alias). This allows a generic
  "Bar TV" name and icon, but not the bar's own logo, and Fire TV launchers often ignore the switch.

The plan starts with in-app branding only. Custom builds can be added later without changing anything else.

## Risks and limits

- **This PC can't build the Android app** (no JDK, Android SDK or the signing key). The server and website can be
  built and tested here. The Android steps need a machine that has those, or the app code gets written here and
  built elsewhere.
- **Fire OS 5 (API 22)** is the oldest TV the app supports. Overlays should use plain views, as the rest of the
  app does.
- **Free plan limits** can change. The design keeps well under them, and paid Workers start at about $5 a month
  if a lot of bars sign on.
- **The upstream repo is public**, so the server code will be public too. That's fine as long as secrets stay in
  `wrangler secret`, never in files.

## Still open (decide later, defaults in brackets)

- Domain name [the free `*.workers.dev` address to start]
- Banner style and placement [top, full width, bar's image on the left]
- Whether staff can preview a special on one screen before it goes live [yes, a "Show now" button]
