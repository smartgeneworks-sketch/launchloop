# Going live

Takes about 30–60 minutes, plus however long each platform takes to approve your app.

## What "live" means on day one

| Part | Live on day one? | What it needs |
|---|---|---|
| Hosted dashboard at a public https URL | ✅ | Render or Fly.io account, ~$7/mo for an instance with a persistent disk |
| Real AI generation (copy, scripts, storyboards, tasks) | ✅ | `GEMINI_API_KEY` or `OPENAI_API_KEY` |
| Auto-posting to **X** | ✅ text posts with the tracked link | `X_USER_ACCESS_TOKEN` (OAuth 2.0 user token, `tweet.write`) on an X API tier that allows posting |
| Auto-posting to **LinkedIn** | ✅ text posts with the tracked link | `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_AUTHOR_URN` (`w_member_social` for a person, Community Management API for a company page) |
| Instagram, Facebook, Threads, YouTube, TikTok | ⏳ Share Kit for now | Meta / Google / TikTok app review, plus PNG and MP4 rendering (see the end of this file) |
| Reddit, Product Hunt | Share Kit by design | — |
| Conversion tracking | ✅ | Your app calls `POST /api/webhooks/conversion` (see README) |

Any channel without credentials automatically creates a Share Kit task. Nothing fails silently.

## Option A: Render (recommended, about 10 clicks)

1. Push this folder to a GitHub repo.
2. In Render, go to **New → Blueprint**, pick the repo, and `render.yaml` sets everything up: Docker, a 1 GB disk at `/data`, a health check and a generated `APP_API_TOKEN`.
3. Fill in the secret fields Render asks for:
   - `PUBLIC_BASE_URL`: your Render URL, e.g. `https://launchloop.onrender.com`
   - `GEMINI_API_KEY` **or** `OPENAI_API_KEY`
   - X and/or LinkedIn tokens (optional; leave them blank to use the Share Kit)
4. Deploy. Open the URL, paste `APP_API_TOKEN` (copy it from Render → Environment) when the app asks, then create your workspace and import your site.

## Option B: Fly.io

```bash
fly launch --no-deploy --copy-config
fly volumes create launchloop_data --size 1
fly secrets set APP_API_TOKEN=$(openssl rand -hex 24) PUBLIC_BASE_URL=https://<app>.fly.dev GEMINI_API_KEY=...
fly deploy
```

## Option C: any VPS with Docker

```bash
docker build -t launchloop .
docker run -d --restart unless-stopped -p 3000:3000 -v launchloop-data:/data \
  -e APP_API_TOKEN=$(openssl rand -hex 24) -e PUBLIC_BASE_URL=https://your.domain \
  -e PUBLISH_MODE=live -e GEMINI_API_KEY=... launchloop
```

Put Caddy or nginx in front of it for HTTPS.

## Production behaviour (`NODE_ENV=production`)

- The app **refuses to start without `APP_API_TOKEN`**, so the dashboard is never public.
- The Relay demo data is **not** seeded (`SEED_DEMO=false`). You start with an empty workspace.
- `/api/health` and the signed webhooks are the only routes that work without the token. Media URLs are also public, because platform APIs need to fetch them.
- The process shuts down cleanly on SIGTERM. Run **one** instance: the scheduler runs inside the process, and SQLite lives on the disk.

## Before your first real post

1. Create the workspace, import your site, and fix any facts that came out wrong.
2. Check **Product source → Channels**: X and LinkedIn should show `connected`; the others show Share Kit.
3. Approve one low-stakes post and click **Publish now**. Check that it appears on the platform and that the publish log shows the post URL.
4. Send a test conversion with `npm run webhook -- conversion --url https://your.domain ...` and confirm it appears under Analytics.

## Backups

Everything lives in `/data/launchloop.db`. Snapshot the disk (Render and Fly both offer this) or copy the file on a schedule.

## Next steps to unlock the other channels

1. **Server-side PNG/JPEG rendering.** Instagram and Facebook won't accept SVG. Add `sharp` (or `@resvg/resvg-js`) and expose `/api/assets/:id/media.jpg`.
2. **MP4 rendering** of the render job, with Remotion or FFmpeg, for Reels, Shorts and TikTok.
3. **Adapters** in `src/services/publisher.js` for the Instagram Graph API (container → publish), Facebook Pages, the YouTube Data API and the TikTok Content Posting API, each behind its platform's app review.
