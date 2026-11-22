# LaunchLoop

LaunchLoop is a campaign studio for founders, marketers and creators. You connect your website or product, and it generates **reels, short videos, flyers, social posts and carousels**. You approve them, and it **schedules or auto-posts** them through official APIs, or gives you a **One-Tap Share Kit** for channels that need manual posting. It also runs the **launch timeline**: tasks, progress, UTM attribution, and a loop that generates new variations from your best performers.

It needs no dependencies and no build step, and it runs fully offline in mock mode.

```bash
node -v          # needs Node 22.5+ (uses the built-in node:sqlite)
npm start        # → http://localhost:3000
```

The first start seeds a demo launch, **"Relay 2.0"**, with creatives in every approval state. It includes a scheduled Instagram post that the worker publishes about a minute after start, a TikTok reel that becomes a Share Kit task, published posts with labelled simulated metrics, attributed conversions, and a half-done checklist.

| Command | What it does |
|---|---|
| `npm start` | Run the server and the scheduler worker |
| `npm run dev` | Same, restarting on file changes |
| `npm run seed` | Reset the database to the demo data |
| `npm test` | 15 tests: state machine, scheduler, regeneration, UTM, webhooks, robots.txt, HTTP API |
| `npm run webhook -- …` | Sign and send a test webhook (see below) |

## What's in the app

| Page | What you can do |
|---|---|
| **Dashboard** | Campaign progress ring, publish readiness, next publish, attributed signups, state pipeline, upcoming and overdue tasks, channel readiness, publish log, post-publish iteration prompt |
| **Product source** | Import from a URL (respects robots.txt) or paste text. Edit features, value props, pain points, offer and referral mechanic. Brand kit (colours, fonts, logo, screenshots). Locale (currency, date format, regional tone). Per-channel API vs Share Kit mode and auto-publish rules. Webhook secret |
| **Creative studio** | Generate a package per channel × format. Filter by format or state. Inline editor for headline, caption (with a per-platform character counter), CTA, hashtags, storyboard VO and on-screen text, slides and flyer props. Regenerate one creative in place, or as a variant if it's locked. Hook & Virality Advisor. SVG or PNG export. Video render job |
| **Approval queue** | Approve or request changes (a note is required). Set the publish time and auto-publish per item. Toggle auto-publish rules per channel. Unschedule, retry failed posts, open the Share Kit, mark published |
| **Timeline & tasks** | Day-by-day timeline from L-10 to L+7 mixing tasks and posts, or a by-category view. Completion toggles, filters, add or delete tasks |
| **Analytics & loop** | KPIs, a per-creative table with the source of each number (simulated, webhook or manual), manual metric entry, conversions by channel, one-click follow-up variation, UTM link builder |

## Mock and local mode (default)

| Layer | Without keys | With keys |
|---|---|---|
| AI | Deterministic template generator built only from your workspace facts (no invented stats) | `GEMINI_API_KEY` or `OPENAI_API_KEY` |
| Images | Brand-aware SVG flyers, post images and slides, exported to PNG in the browser | Optional OpenAI background art (`AI_IMAGE_GENERATION=true`) |
| Video | Storyboard, script, captions, animated preview, and **Download video**: an MP4 recorded in your browser with generated music and burned-in captions | Adds an AI **voiceover** (Gemini TTS, `GEMINI_TTS_MODEL`, default `gemini-3.8-flash-tts`; or OpenAI `OPENAI_TTS_MODEL`). The server converts recordings to H.264/AAC with ffmpeg (installed in the Docker image) |
| AI clips & uploaded videos | **🎵 Music & voiceover** in the editor: generated track or your own file, music volume, original-sound level, optional voiceover; preview before applying. Mixed in the browser and muxed onto the clip by ffmpeg without re-encoding the picture. The original is kept ("restore original sound"). Changing the sound sends an approved creative back to review | Voiceover needs a TTS key |
| Publishing | `PUBLISH_MODE=mock`: API channels publish through a simulated adapter (`MOCK_FAILURE_RATE` exercises retries and FAILED). Share Kit channels create manual tasks | `PUBLISH_MODE=live` plus platform credentials |
| Metrics | Simulated, and labelled as simulated in the UI | Manual entry and conversion webhooks today. Platform insights APIs are the next step |

Copy `.env.example` to `.env` to configure. Every value is optional.

## External keys and webhooks for live publishing

- **AI:** `GEMINI_API_KEY` (model in `GEMINI_MODEL`) or `OPENAI_API_KEY` (models in `OPENAI_MODEL` and `OPENAI_IMAGE_MODEL`). Model names change often, so set the current ones.
- **X:** `X_USER_ACCESS_TOKEN`. The text post adapter is included.
- **LinkedIn:** `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN`. The text post adapter is included.
- **Meta (Instagram, Facebook, Threads), YouTube, TikTok:** each needs app review or an audit, plus media on a public URL (`PUBLIC_BASE_URL`). Until you add those adapters, these channels route to the Share Kit automatically.
- **Reddit and Product Hunt** always use the Share Kit.

The live adapters were written against the public API docs but haven't been tested against the real platforms, so test them on a sandbox account first. Requirements per platform are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#8-going-live-what-you-need).

### Inbound webhooks (your app → LaunchLoop)

Both endpoints are authenticated with an HMAC signature using the workspace secret (shown on **Product source**):

```
X-LaunchLoop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
X-LaunchLoop-Event-Id:  <unique id>   # optional, makes the request idempotent
```

**`POST /api/webhooks/product-update`** — a new feature or release. LaunchLoop creates a campaign with a launch checklist and generates DRAFT creatives in the background (never auto-approved), and returns `202`.

```json
{ "workspace_id": "ws_…", "event": "feature_released", "title": "AI weekly digest",
  "summary": "One digest of every standup", "features": ["AI digest: summarises a week of standups"],
  "channels": ["linkedin", "x"], "launch_date": "2026-12-01" }
```

**`POST /api/webhooks/conversion`** — a signup, referral or purchase. Attribution reads `utm_content` (or `landing_url`).

```json
{ "workspace_id": "ws_…", "event": "signup", "landing_url": "https://you.com/?utm_source=instagram&utm_campaign=relay_2_0_launch&utm_content=reel-7d9002f19df5-v1" }
```

To try it from the CLI:

```bash
npm run webhook -- conversion --workspace <ws_id> --secret <whsec_…> --campaign relay_2_0_launch --content <utm_content>
npm run webhook -- product-update --workspace <ws_id> --secret <whsec_…> --title "AI digests" --feature "AI digest: summarises threads"
```

## Project layout

```
src/
  server.js              HTTP server, router, static files, auth, webhooks
  db.js                  SQLite schema (CHECK-constrained enums) + tiny data layer
  worker.js              scheduler: claim → gate → publish/Share Kit → retry/fail → tasks/metrics
  seed.js                demo launch data
  lib/channels.js        channel catalog (API route, requirements, limits, aspect ratios)
  services/
    ai.js                AIService: Gemini / OpenAI / mock, normalised output
    mockGenerator.js     offline copy, script, storyboard and slide generator
    core.js              domain logic: workspaces, campaigns, assets, schedule, progress, webhooks, share kit
    stateMachine.js      approval transitions + actor rules + audit events
    scorer.js            Hook & Virality Advisor
    utm.js               UTM builder + utm_content ↔ asset mapping
    ingest.js            robots.txt-aware URL import, SSRF guard, HTML extraction
    media.js             SVG flyers/posts/slides, animated video preview, render job
    publisher.js         mock adapter + live X/LinkedIn adapters, Share Kit fallback
public/                  vanilla JS single-page app (index.html, app.js, styles.css)
docs/ARCHITECTURE.md     system & data model overview
test/app.test.js         node:test suite
scripts/send-webhook.js  signed webhook sender
```

## Why it's built without Next.js

The brief suggested Next.js. I built it without a framework so it runs with just `node` and no `npm install` (this build environment had package installs blocked). The services are framework-free, so moving to Next.js and Postgres is mechanical. The steps are in [ARCHITECTURE §10](docs/ARCHITECTURE.md#10-path-to-production).
