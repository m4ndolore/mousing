# mousing

Live Lightning Lane return times, park crowd trends and a pumpkin finder for
Walt Disney World. It runs on Cloudflare's free plan and installs on a phone as a
web app.

**Demo:** https://mousing.pages.dev (read-only: live data, no alerts)

## What it does

- **Lightning Lane board.** Every Multi Pass and Single Pass ride with its next
  return time, standby wait and price, grouped by park. Pick the rides you care
  about and the board refreshes every 1, 2 or 5 minutes.
- **Alerts** (your own copy only). Push or email when a ride's return time
  lands in your window, or jumps 15 minutes earlier. Limit an alert to your
  trip days and check every minute for two hours when you're in the park.
- **Park crowds today.** Average standby across open rides at each park,
  compared with a usual day, with a projection for the rest of the day, closing
  times and rides that usually sell out.
- **Seasonal outlook.** Whether this month and weekday usually run busier or
  quieter than each park's average.
- **🎃 Finder.** A checklist and map for the fall 2026 EPCOT pumpkin hunt, at
  `/finder`. Progress stays on your phone.

## Run your own copy

You need a Cloudflare account (the free plan is enough) and Node 22.

```bash
git clone https://github.com/m4ndolore/mousing && cd mousing
npm ci
npx wrangler login

# One KV namespace, shared by the site and the cron worker
npx wrangler kv namespace create mousing

cp wrangler.example.toml wrangler.toml
cp src/cron/wrangler.example.toml src/cron/wrangler.toml
# Put the namespace id in both files, and your URLs in WATCHER_URL and APP_URL.

npm run deploy        # the site, on Cloudflare Pages
npm run deploy:cron   # the worker that samples parks and sends alerts
```

Then set the secrets. Pick any long random string for `ADMIN_TOKEN` and
`AUTH_SHARED_SECRET`.

```bash
npx wrangler pages secret put ADMIN_TOKEN
npx wrangler pages secret put AUTH_SHARED_SECRET
cd src/cron && npx wrangler secret put AUTH_SHARED_SECRET
```

Open your site, go to **Settings**, and enter the `ADMIN_TOKEN` value as the
owner key. Alerts and settings work only on devices that have the key.

### Push notifications

Generate a key pair, then store each half where it belongs:

```bash
node scripts/vapid-keys.mjs
npx wrangler pages secret put VAPID_PUBLIC_KEY      # the public key it printed
cd src/cron
npx wrangler secret put VAPID_PRIVATE_JWK           # the JWK it printed
npx wrangler secret put VAPID_SUBJECT               # mailto:you@example.com
```

On iPhone, add the site to your Home Screen first (Share, then Add to Home
Screen). iOS delivers web push only to apps opened from the Home Screen.

### Email alerts (optional)

Email uses Cloudflare Email Routing. Turn it on for a domain you own, verify
your address, uncomment the `send_email` block in `src/cron/wrangler.toml`, and
set `EMAIL_FROM`.

### Park baseline (optional)

Without a baseline, comparisons start after two weeks of your own readings. To
compare from day one:

```bash
ROPEDROP_CONTACT=you@example.com npm run baseline:build
npm run baseline:load
```

Setting `ROPEDROP_CONTACT` in the cron worker's config also refreshes the
RopeDrop Planner parts every week. RopeDrop Planner asks API users to identify
themselves with a contact address, so use your own.

## Run the demo instead

Set `DEMO_MODE = "true"` in both config files and the cron schedule to
`*/15 * * * *`. A demo serves live data to anyone, refuses alerts and settings,
and stays within the free plan: about 100 KV writes a day against a limit of
1,000.

## Development

```bash
npm run dev     # local site with a local KV store
npm run check   # unit tests, page script syntax, and both Cloudflare builds
```

CI runs `npm run check` on every pull request.

## Data and credits

- Live waits, Lightning Lane return times, park hours: [ThemeParks.wiki](https://themeparks.wiki/)
- Usual waits by hour, ride averages, Lightning Lane sell-outs: [RopeDrop Planner](https://ropedropplanner.com/)
- Seasonal crowd levels and ride averages: [Queue-Times.com](https://queue-times.com/)

The app shows these credits wherever their data appears.

## Not affiliated with Disney

mousing is an unofficial fan project. It is not affiliated with, endorsed by,
or sponsored by The Walt Disney Company. Disney, Walt Disney World, Lightning
Lane and attraction names are trademarks of their owners. mousing never asks
for a Disney login and books nothing; it links to the My Disney Experience app.

## License

MIT
