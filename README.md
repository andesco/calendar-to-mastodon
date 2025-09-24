# CalDAV to Mastodon

This Cloudflare Worker automatically posts upcoming events (in a public CalDAV calendar) to a Mastodon account. It runs daily and checks for meetings scheduled for a configurable number of days ahead.

## Features

- automatically checks for upcoming events daily
- posts formatted announcements to Mastodon
- serverless function via Cloudflare Workers
- web interface for manual posting, protected by Cloudflare Access

## Setup

### 0. Prerequisites

- Cloudflare account
- Mastodon account and access token with `write:statuses` permission
- A public CalDAV calendar feed that supports the [sabre/dav ICSExportPlugin](https://sabre.io/dav/ics-export-plugin/).

> [!IMPORTANT]
> This worker requires a CalDAV server with the [sabre/dav ICS Export Plugin](https://sabre.io/dav/ics-export-plugin/) enabled, which allows this Worker to efficiently fetch events in jCal format, within a limited date range. For example:
>
> `{CALENDAR_EXPORT_URL}&accept=jcal&start={timestamp}&end={timestamp}&expand=1`

### 1. Deploy

#### Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/andesco/cloudflare-worker-caldav-to-mastodon)

#### Cloudflare Dashboard

<nobr>Workers & Pages</nobr> ⇢ Create an application ⇢ [Clone a repository](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/deploy-to-workers): \
   `http://github.com/andesco/cloudflare-worker-caldav-to-mastodon`

#### Wrangler CLI

Update `wrangler.toml` to set your environment variables:

```toml wrangler.toml
[vars]
CALENDAR_EXPORT_URL = "{URL}"
MASTODON_INSTANCE_URL = "{URL}"
DAYS_AHEAD = "1"
```

```bash
cd cloudflare-worker-caldav-to-mastodon
wrangler login
wrangler deploy
```

### 2. Enable Cloudflare Access

To protect the web interface and API (both optional) this worker requires Cloudflare Access. All HTTP requests are blocked by default unless authenticated.

1. [Cloudflare Dashboard](https://dash.cloudflare.com) ⇢ Zero Trust ⇢ Access ⇢ Applications
2. Add an application for your Worker and its hostnames.
3. Configure authentication rules (email, domain, etc.)

> [!Note]
> Deploy your worker, verify through the web interface can read your public calendar, and secure access though Cloudflare Access before saving your Mastodon token to `MASTODON_ACCESS_TOKEN`.

> [!NOTE]
> If your worker is protected by Cloudflare Access, use `cloudflared` CLI to authenticate:
> ```bash
> cloudflared access curl https://{worker}.{subdomain}.workers.dev/post/day -X POST
> ```

### 3. Get Mastodon Access Token

1. Mastodon instance ⇢ Settings ⇢ Development ⇢ New Application
2. Permissions:  `write:statuses`
3. Save
4. Copy `{your access token}`

### 4. Add Secrets and Environment Variables

   #### Cloudflare Dashboard

   [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/) ⇢ `{worker}` ⇢ Settings: <nobr>Variables and Secrets: Add:</nobr> \
   `MASTODON_ACCESS_TOKEN` \
   `CLOUDFLARE_ACCESS_TEAM` \
   `CLOUDFLARE_ACCESS_AUD` \

#### Wrangler CLI
    
 ```bash
 wrangler secret put MASTODON_ACCESS_TOKEN
 wrangler secret put CLOUDFLARE_ACCESS_TEAM
 wrangler secret put CLOUDFLARE_ACCESS_AUD
 ```

### 5. Modify Schedule
 
   #### Cloudflare Dashboard
   
   [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/) ⇢ `{worker}` ⇢ Settings: <nobr>Trigger Events: Edit</nobr>
    
   #### Wrangler CLI
   
   The default schedule is set to run daily at 5:30 PM UTC. Modify the cron schedule in `wrangler.toml` and redeploy.
   
   ```toml wrangler.toml
   [triggers]
   crons = ["30 17 * * *"]
   ```

## Environment Variables & Secret

| Variable | Description | Example |
|----------|-------------|---------|
| `CALENDAR_EXPORT_URL` | CalDAV calendar subscription URL | `https://social.coop/calendar/?export` |
| `MASTODON_INSTANCE_URL` | Mastodon instance URL | `https://social.coop` |
| `DAYS_AHEAD` | days ahead to post events | `0` &nbsp; `1` &nbsp; `0,1,14` |
| `MASTODON_ACCESS_TOKEN` | access token from Mastodon | `your-private-access-token` |
| `CLOUDFLARE_ACCESS_TEAM` | Cloudflare Access subdomain | `your-team-name` |
| `CLOUDFLARE_ACCESS_AUD` | Application audience (AUD) tag | `a1b2c3d4…` |
| `ENVIRONMENT` | bypass authentication | `development` |

> [!NOTE]
> `DAYS_AHEAD` <br> `0` posts all events occuring today <br> `1` posts all events occuring tomorrow (default) <br> `0,1,14` posts all events occuring today, tomorrow, and in 14 days


## Usage

### Automatic Operation

Once deployed and configured, the Worker will:
- run daily at your scheduled time (defaulting to 17:30 UTC);
- check for events occuring in `{DAYS_AHEAD} days; and
- post formatted announcements to Mastodon for each event.

### Manual Posting

Visit your Worker in a browser for a simple web interfac:
```
https://{worker}.{subdomain}.workers.dev
```

## API

The worker API is protected by Cloudflare Access. To make requests from the command line, use the `cloudflared` CLI to authenticate.

#### GET /api/events

```bash
cloudflared access curl "https://{worker}.{subdomain}.workers.dev/api/events?days={days}"
```
-   fetch events within specified `{days}`

#### POST /trigger

```bash
cloudflared access curl -X POST https://{worker}.{subdomain}.workers.dev/post/day
```
- checks for events occurring in `{DAYS_AHEAD}` days and posts to Mastodon
- runs automatically via cron schedule

```bash
cloudflared access curl -X POST https://{worker}.{subdomain}.workers.dev/post/next
```
- posts the closest event within the next 2 weeks


## Other Notes

#### Changing Post Format

Modify the `postToMastodon()` function to customize:
- post text and emojis
- visibility settings (`public`, `unlisted`, `private`)
- character limits and truncation

#### Filtering Events

By default, the worker does not post all-day or multi-day events. You can change this behavior in the `checkAndPostDayEvents()` function.

Additionally, you can add your own filters in `checkAndPostDayEvents()` to only post certain events. For example, to only post events that include 'Public' or 'Community' in their summary:

```javascript
const tomorrowEvents = events.filter(event => {
  const eventDate = new Date(event.start);
  const isValidDate = eventDate >= tomorrow && eventDate <= tomorrowEnd;
  const isRelevantEvent = event.summary.includes('Public') || event.summary.includes('Community');
  return isValidDate && isRelevantEvent;
});
```

#### Time Zone Handling

The Worker uses UTC by default. To handle specific timezones:

```javascript
const tomorrow = new Date();
// Convert to specific timezone
const options = { timeZone: 'America/Toronto' };
const localDate = new Date(tomorrow.toLocaleString('en-US', options));
```

#### File Structure

```
cloudflare-worker-caldav-to-mastodon/
├── index.js          # main Cloudflare Worker code
├── README.md         # this document
└── wrangler.toml     # Wrangler configuration (optional)
```