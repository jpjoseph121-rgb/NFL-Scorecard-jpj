# NFL 2026 — Scorecard + Shared League (25-player test build)

A live, mobile-first football scorecard with a **tamper-proof shared league** for up to
**25 players**, plus **lock reminders** 30 minutes before kickoff.

Predict the final score before each game (**+5** exact score · **+3** both teams within 5
points · **+1** right winner), and watch a single live leaderboard that everyone sees.
Free to run: no API keys, no accounts, no database to administer.

Built on the same architecture as the MLB 2026 scorecard — same four tabs, same league
server design, same hosting steps.

---

## League details

| | |
|---|---|
| Season | 2026 · Sep 9, 2026 (Patriots @ Seahawks) – Jan 10, 2027 (Week 18), postseason to follow |
| Teams | 32 (AFC/NFC × North/South/East/West) |
| Regular-season games | 272 (17 per team, 18 weeks, one bye each) |
| Data source | ESPN's public NFL data (`site.api.espn.com`) — free, no key |
| Default invite code / board | `GRIDIRON26` / "NFL 2026 Pick'em" |
| Roster cap | 25 players |

## How scoring works

Before kickoff, predict the final points for both teams. Best matching tier counts (they do
not stack):

- **+5** — exact final score for both teams
- **+3** — both teams' scores within 5 points (±5, inclusive) of the final
- **+1** — right winner (or you called a tie and it tied)
- **0** — otherwise

Stats bar: **Predicted** (picks made), **Points**, **Win %** (share of finished picks where
you had the right winner). Tiebreakers on the board: points, then exact scores, then
decided games.

Picks **lock at kickoff, enforced on the server** against the official schedule — the device
clock is ignored. Other players' picks stay hidden until their game kicks off; tap anyone on
the leaderboard to see their locked picks against the finals.

---

## Files
```
index.html                    the app (Games · My Team · Standings · League)
sw.js                         service worker (Home Screen install + notifications)
manifest.json, icon*.png      PWA install metadata + icons
netlify.toml                  build config
package.json, node_modules/   @netlify/blobs, vendored so drag-and-drop works
netlify/functions/scores.js   read-only proxy to ESPN (schedule + standings only, 30s cache)
netlify/functions/league.js   authoritative league server (scoring + locks + cap)
```

## Set your invite code (30 seconds)
In `index.html`, near the top of the script:
```js
var LEAGUE_CODE = "GRIDIRON26";
var LEAGUE_NAME = "NFL 2026 Pick'em";
```
Change the code to your own (2–24 letters/numbers, e.g. `"FREEHOLD26"`). Everyone who opens
your deployed site shares that one board.

To change the roster limit, edit `MAX_PLAYERS` at the top of `netlify/functions/league.js`
(default 25), or set a `MAX_PLAYERS` environment variable in Netlify (Site configuration →
Environment variables).

## Host it (~2 minutes)
**Drag-and-drop:** go to https://app.netlify.com/drop and drag this whole folder on. You'll
get a URL like `https://your-name.netlify.app` — share that with your group. The league
store (Netlify Blobs) provisions itself; there is nothing to configure.

**From Git / CLI:** import the repo in Netlify (no build command needed) or run
`netlify deploy --prod` from this folder.

> The league requires the Netlify functions, so host the whole folder on Netlify. If you
> serve the page elsewhere, set `var PROXY = "https://your-site.netlify.app";`.

## How your group plays
1. Open the site → **League** tab → enter a name → **Join**. Tap **Copy invite** to share.
2. Optionally tap **Turn on** for lock reminders (install to Home Screen first on iPhone).
3. In **Games**, predict the score before kickoff. **My Team** shows a full 18-week slate
   (with the bye) for your club. **Standings** switch between divisions and conferences.
4. Watch the leaderboard — points, exact scores, win% — update live for everyone.

## About the reminders (one honest limitation)
Reminders fire reliably while the app is **open or running in the background**. For alerts
with the app fully closed, iOS and Android require the site to be installed to the Home
Screen (iPhone: Safari → Share → **Add to Home Screen**). Guaranteed delivery with the phone
asleep needs true server-sent push; the service worker is already wired for it.

## Things worth knowing
- **Data source.** ESPN's NFL endpoints are free and widely used but unofficial and
  unsupported; they could change. The proxy is locked to schedule + standings only.
- **Flex games.** Some late-season games have "TBD"/flex kickoff times. Locks always follow
  the official time as ESPN currently lists it, so a rescheduled game re-locks accordingly.
- **Standings order** is win % then point differential; official NFL tiebreakers and playoff
  seeding can differ slightly.
- **Private test only.** This build uses free non-commercial data and league team marks,
  which is appropriate for a private, unmonetized group. A paid product would require
  commercial data licensing and resolving logos/marks.
