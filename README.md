# Training History

An installable training log for strength work, climbing, Kilter board sessions, Hangboard protocols and workout planning. The app starts empty. It contains no imported workout history, personal bodyweight, notes, climb library or original workbook.

## Use the app

Open the deployed HTTPS app and sign in with an account allowed by its private sharing settings. Use **Install app** in the header, or the browser's installation menu. Installation adds an app icon and opens the dashboard in its own window where the browser supports it.

- **Desktop Chrome / Edge:** use the app's install button when the browser offers installation, or its app installation menu.
- **iPhone / iPad:** open in Safari, choose **Share → Add to Home Screen**, and keep **Open as Web App** enabled when shown.
- **Mac Safari:** choose **File → Add to Dock**.

Loading and saving workouts requires an internet connection. An offline launch shows a reconnect screen; it does not show cached training history or queue writes. Save a draft before closing the app. Updates wait for the existing app windows to close so an update does not reload an open workout form.

## What it does

| Area | Features |
| --- | --- |
| Strength | Add exercises and sets; recoverably delete records; export CSV; filter dates and sides; archive older exercises. |
| Charts | Working-set workout averages; hover breakdowns; linear, quadratic and smoothed fits; fitted change percentage; expanded/zoomable plots; rotatable 3D training surfaces. |
| Climbing | Separate indoor/outdoor boulder, lead and top-rope histories; named climbs, tags, grade ranges, effort, rest and notes; name autocomplete; cumulative attempts across sessions. |
| Kilter | Independent board history with wall angle and per-angle attempt totals. |
| Hangboard | Repeaters and max hangs; cycles, sets, hangs and separate rest intervals; optional workout bodyweight. |
| Calendar | Planned workouts, targets, explicit target reviews and comments. |

Bodyweight starts **unset**. Enter it in **Chart settings** to calculate pull-up total load, strength estimates and volume. Repetitions and recorded added load work without a bodyweight assumption.

## Data and access model

This edition is **one shared log per deployed application**. Everyone granted access to that deployment can use the same log. It is not a service with a separate private database for each visitor.

The hosted version uses the Sites private visitor allowlist to protect the dashboard, static assets and APIs. Its database is separate from any other training dashboard. The five database tables are created by schema-only migrations; no workout records are seeded.

**Independent hosting requires an authentication gateway or equivalent server-side authorization before internet exposure.** The API handlers rely on the private deployment boundary and do not implement an independent login system. A private GitHub repository does not make a publicly hosted app private. Keep the entire origin behind access control, including `/api/*`, static assets and authentication routes. Add per-user ownership checks before turning this into a public multiuser service.

## Architecture

| Location | Purpose |
| --- | --- |
| `public/dashboard.html`, `public/app.js` | Dashboard and strength workflow. |
| `public/*-model.js`, `public/analytics.js`, `public/fit-engine.js` | Validation, workout analytics and chart fitting. |
| `public/climbing.js`, `public/hangboard.js`, `public/calendar.js` | Training and planning interfaces. |
| `app/api/`, `lib/*-api.js` | Worker-backed JSON endpoints and persistence handlers. |
| `db/schema.ts`, `drizzle/` | D1 schema and ordered schema-only migrations. |
| `public/manifest.webmanifest`, `public/icons/` | Installable app identity and icons. |
| `public/pwa.js`, `public/pwa.css` | Install guidance, connection status and worker registration. |
| `public/sw.js`, `public/offline.html` | Minimal offline fallback. Only the generic fallback and app icons are cached. |

The framework is Vinext/Vite with a Cloudflare Worker and D1 database. The UI is primarily vanilla JavaScript. GitHub stores the source; GitHub Pages alone cannot run this app's server routes and database.

## Local development

Use Node.js **24 LTS**, npm and Git. The project declares a minimum Node version in `package.json`; Node 24 also supports the SQLite test runtime used by the included tests.

```sh
npm ci
npm test
npm run build
```

The first local build creates `dist/server/wrangler.json`. Before the first local run, apply the schema migrations **once, in this order**. These commands target only the local preview database:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_new_pete_wisdom.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_reflective_scalphunter.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_right_adam_warlock.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0003_previous_ghost_rider.sql
npm run dev
```

Use the local URL printed by the development server. `npm start` previews the built Worker instead of the development server. Both use `.wrangler/state`. Do not replay an already-applied migration; later schema changes should append a new migration. Local databases and generated build output are ignored by Git.

Installation and service workers require HTTPS or a browser-trusted local development origin such as localhost. A plain HTTP remote preview can test the UI but cannot prove real app installation.

## Deployment

The source manifest `.openai/hosting.json` declares the logical `DB` binding. In the reusable GitHub edition it intentionally has no hosted project identity. A Sites-managed checkout adds its own `project_id`; this does not belong to another person's independent deployment.

For Sites hosting, use the supported Sites build/publish workflow. It provisions the app's storage and applies the migrations before publishing. For independent hosting, provision a Cloudflare Worker and D1 database, supply their deployment configuration, apply the included migrations and set up private access protection before exposing the origin. The generated local placeholder database ID is not a production database binding. No hosting credentials or account secrets are included in this repository.

## Tests

`npm test` runs synthetic tests for:

- Empty data and unset-bodyweight behavior, ordinary exercise metrics and pull-up calculations.
- Fitted change and 3D surface eligibility.
- Schema-only database creation and first saves for strength, climbing, Kilter, Hangboard and plans.
- Installable manifest fields, actual icon dimensions and authenticated manifest loading.
- The service worker's strict cache allowlist, authentication exclusions, offline fallback and update lifecycle.

Tests run with synthetic fixtures and an in-memory SQLite database. They do not write to the deployed app.

## Export reusable source

From a Git checkout, export the complete source to an empty folder:

```sh
npm run export:github -- /absolute/path/to/empty-folder
```

The export preserves code, assets, lockfile, migrations, tests and vendored licenses. It removes the hosted project identity and excludes Git history, credentials, runtime databases, dependencies and build artifacts. It refuses to overwrite a populated destination. Publish that folder to a new private repository; the live app's managed source remote remains separate.

## Platform references

- [MDN: Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)
- [MDN: Install prompts](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event)
- [WebKit: Safari 26 web apps](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
