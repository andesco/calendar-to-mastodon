// Cloudflare Worker to post calendar events to Mastodon
// Set up environment variables in your Cloudflare dashboard:
// MASTODON_INSTANCE_URL, MASTODON_ACCESS_TOKEN, CALENDAR_ICS_URL
// CLOUDFLARE_ACCESS_TEAM, CLOUDFLARE_ACCESS_AUD

import { RRule } from 'rrule';
import ICAL from 'ical.js';

// --- JWT Validation for Cloudflare Access ---

/**
 * Decode a base64url string.
 * @param {string} b64url 
 * @returns {Uint8Array}
 */
const b64url_to_uint8array = (b64url) => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const a = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    a[i] = raw.charCodeAt(i);
  }
  return a;
};

/**
 * Validate the JWT from Cloudflare Access.
 * @param {Request} request 
 * @param {any} env 
 * @returns {Promise<boolean>}
 */
async function validateJWT(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return false;
  }

  const [header_b64, payload_b64, signature_b64] = jwt.split('.');
  const header = JSON.parse(atob(header_b64));
  if (header.alg !== 'RS256') {
    console.error('Unexpected JWT algorithm:', header.alg);
    return false;
  }

  const certsURL = `https://` + env.CLOUDFLARE_ACCESS_TEAM + `.cloudflareaccess.com/cdn-cgi/access/certs`;
  const response = await fetch(certsURL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) {
    console.error('Failed to fetch Access certs');
    return false;
  }
  const jwks = await response.json();
  const key = jwks.keys.find(k => k.kid === header.kid);
  if (!key) {
    console.error('Matching key not found in JWKS');
    return false;
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signature = b64url_to_uint8array(signature_b64);
    const data = new TextEncoder().encode(`${header_b64}.${payload_b64}`);

    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signature,
      data
    );

    if (!isValid) {
      console.error('JWT signature validation failed');
      return false;
    }

    const payload = JSON.parse(atob(payload_b64));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp < now) {
      console.error('JWT has expired');
      return false;
    }
    if (payload.nbf > now) {
      console.error('JWT not yet valid');
      return false;
    }
    if (payload.iss !== `https://` + env.CLOUDFLARE_ACCESS_TEAM + `.cloudflareaccess.com`) {
      console.error('JWT issuer is incorrect');
      return false;
    }
    if (!payload.aud.includes(env.CLOUDFLARE_ACCESS_AUD)) {
      console.error('JWT audience is incorrect');
      return false;
    }

    return true;
  } catch (err) {
    console.error('Error during JWT validation:', err);
    return false;
  }
}

// --- Main Worker Logic ---

export default {
  async scheduled(event, env, ctx) {
    try {
      await checkAndPostDayEvents(env);
    } catch (error) {
      console.error('Error in scheduled function:', error);
    }
  },

  async fetch(request, env, ctx) {
    // Require authentication by default, unless in a development environment
    if (env.ENVIRONMENT === 'development') {
      console.warn('WARNING: Running in development mode — authentication is disabled');
    } else {
      if (!env.CLOUDFLARE_ACCESS_TEAM || !env.CLOUDFLARE_ACCESS_AUD) {
        return new Response('Identity provider not configured. Set CLOUDFLARE_ACCESS_TEAM and CLOUDFLARE_ACCESS_AUD secrets.', { status: 500 });
      }

      const authorized = await validateJWT(request, env);
      if (!authorized) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    const url = new URL(request.url);
    
    if (request.method === 'POST' && url.pathname === '/post') {
      try {
        await checkAndPostEvents(env);
        return new Response('Calendar check completed', { status: 200 });
      } catch (error) {
        console.error('Error in /post:', error);
        return new Response('Internal server error', { status: 500 });
      }
    }

    if (request.method === 'POST' && url.pathname === '/post/day') {
      try {
        const result = await checkAndPostDayEvents(env);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error in /post/day:', error);
        return new Response(JSON.stringify({ success: false, message: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/post/tomorrow') {
      try {
        const result = await checkAndPostDayEvents(env);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error in /post/tomorrow:', error);
        return new Response(JSON.stringify({ success: false, message: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/post/next') {
      try {
        const result = await checkAndPostNextEvent(env);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error in /post/next:', error);
        return new Response(JSON.stringify({ success: false, message: 'Internal server error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/post/event') {
      try {
        const event = await request.json();
        if (!event || typeof event.summary !== 'string' || event.summary.length === 0 || event.summary.length > 500) {
          return new Response('Invalid event data', { status: 400 });
        }
        await postToMastodon(env, event);
        return new Response('Event posted successfully', { status: 200 });
      } catch (error) {
        console.error('Error in /post/event:', error);
        return new Response('Internal server error', { status: 500 });
      }
    }
    
    if (request.method === 'GET' && url.pathname === '/api/events') {
      try {
        const days = parseInt(url.searchParams.get('days') || '14');
        if (isNaN(days) || days < 1 || days > 28) {
          return new Response(JSON.stringify({ error: 'Invalid days parameter. Must be between 1 and 28.' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400
          });
        }

        const { events, debug } = await getWebEvents(env, days);
        const responseData = { events };
        if (env.ENVIRONMENT === 'development') responseData.debug = debug;

        return new Response(JSON.stringify(responseData), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      } catch (error) {
        console.error('Error in /api/events:', error);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 500
        });
      }
    }
    
    if (request.method === 'GET') {
      return new Response(getWebInterface(env), {
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
        },
        status: 200
      });
    }
    
    return new Response('Calendar to Mastodon Worker is running', { status: 200 });
  }
};

async function fetchCalendarEvents(env, days = 14) {
  if (!env.CALENDAR_EXPORT_URL || !env.CALENDAR_EXPORT_URL.startsWith('https://')) {
    throw new Error('CALENDAR_EXPORT_URL must be set and use HTTPS');
  }
  const caldavUrl = env.CALENDAR_EXPORT_URL.replace('?export', '');

  const now = Math.floor(Date.now() / 1000);
  const startDate = now;
  const endDate = now + (days * 24 * 60 * 60);

  const exportUrl = `${caldavUrl}?export&accept=jcal&start=${startDate}&end=${endDate}&expand=1`;

  const response = await fetch(exportUrl, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CalDAV export failed: ${response.status} - ${errorText}`);
  }

  const jcalData = await response.json();
  const vcalendar = new ICAL.Component(jcalData);
  const events = vcalendar.getAllSubcomponents('vevent');

  return {
    events: events,
    debug: {
      exportUrl: exportUrl,
      jcalData: jcalData
    }
  };
}

function isAllDayOrMultiDay(vevent) {
  const dtstart = vevent.getFirstProperty('dtstart');
  if (!dtstart) return false;

  if (dtstart.getFirstValue().isDate) {
    return true;
  }

  const dtend = vevent.getFirstProperty('dtend');
  if (dtend) {
    const startDate = dtstart.getFirstValue().toJSDate();
    const endDate = dtend.getFirstValue().toJSDate();
    const duration = endDate.getTime() - startDate.getTime();

    if (duration >= 24 * 60 * 60 * 1000) {
      return true;
    }
  }

  return false;
}

async function checkAndPostEvents(env) {
  const now = new Date();
  const upcomingLimit = new Date(now.getTime() + 360 * 60 * 60 * 1000); // ~15 days

  const { events: rawEvents } = await fetchCalendarEvents(env);

  const eventsToPost = [];

  for (const vevent of rawEvents) {
    if (isAllDayOrMultiDay(vevent)) {
      continue;
    }
    const summary = vevent.getFirstPropertyValue('summary');
    const uid = vevent.getFirstPropertyValue('uid');
    const location = vevent.getFirstPropertyValue('location');
    const description = vevent.getFirstPropertyValue('description');
    const url = vevent.getFirstPropertyValue('url');
    const dtstart = vevent.getFirstProperty('dtstart');
    const rruleProp = vevent.getFirstProperty('rrule');

    if (rruleProp) {
      const rruleOptions = RRule.parseString(rruleProp.getFirstValue().toString());
      rruleOptions.dtstart = dtstart.getFirstValue().toJSDate();
      if (dtstart.getFirstValue().timezone) {
        rruleOptions.tzid = dtstart.getFirstValue().timezone;
      }

      const rule = new RRule(rruleOptions);

      const occurrences = rule.between(now, upcomingLimit);

      for (const occurrence of occurrences) {
        eventsToPost.push({
          uid: uid,
          summary: summary,
          start: occurrence.toISOString(),
          location: location,
          description: description,
          url: null
        });
      }
    } else {
      const startDate = dtstart.getFirstValue().toJSDate();
      if (startDate > now && startDate < upcomingLimit) {
        eventsToPost.push({
          uid: uid,
          summary: summary,
          start: startDate.toISOString(),
          location: location,
          description: description,
          url: null
        });
      }
    }
  }

  for (const event of eventsToPost) {
    await postToMastodon(env, event);
  }
}

async function checkAndPostDayEvents(env) {
  const now = new Date();
  
  // Parse comma-separated days ahead (max 4 values, 0-15 range, default: "1")
  const daysAheadStr = env.DAYS_AHEAD || '1';
  const daysArray = daysAheadStr.split(',')
    .map(d => parseInt(d.trim()))
    .filter(d => !isNaN(d) && d >= 0 && d <= 15)
    .slice(0, 4); // Max 4 values
  
  // Remove duplicates and sort
  const uniqueDays = [...new Set(daysArray)].sort((a, b) => a - b);
  
  // If no valid days, default to [1]
  if (uniqueDays.length === 0) {
    uniqueDays.push(1);
  }

  // Determine max days to fetch calendar events
  const maxDays = Math.max(...uniqueDays) + 1;
  const { events: rawEvents } = await fetchCalendarEvents(env, Math.max(1, maxDays));

  const allEventsToPost = [];

  // Process each day
  for (const daysAhead of uniqueDays) {
    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() + daysAhead);
    targetDate.setHours(0, 0, 0, 0); // Start of target date

    const targetDateEnd = new Date(targetDate);
    targetDateEnd.setDate(targetDate.getDate() + 1); // End of target date

    for (const vevent of rawEvents) {
      if (isAllDayOrMultiDay(vevent)) {
        continue;
      }
      const dtstart = vevent.getFirstProperty('dtstart');
      const rruleProp = vevent.getFirstProperty('rrule');

      if (rruleProp) {
        const rruleOptions = RRule.parseString(rruleProp.getFirstValue().toString());
        rruleOptions.dtstart = dtstart.getFirstValue().toJSDate();
        if (dtstart.getFirstValue().timezone) {
          rruleOptions.tzid = dtstart.getFirstValue().timezone;
        }

        const rule = new RRule(rruleOptions);
        const occurrences = rule.between(targetDate, targetDateEnd, true); // Include start and end

        for (const occurrence of occurrences) {
          allEventsToPost.push({
            uid: vevent.getFirstPropertyValue('uid'),
            summary: vevent.getFirstPropertyValue('summary'),
            start: occurrence.toISOString(),
            location: vevent.getFirstPropertyValue('location'),
            description: vevent.getFirstPropertyValue('description'),
            url: null
          });
        }
      } else {
        const startDate = dtstart.getFirstValue().toJSDate();
        if (startDate >= targetDate && startDate < targetDateEnd) {
          allEventsToPost.push({
            uid: vevent.getFirstPropertyValue('uid'),
            summary: vevent.getFirstPropertyValue('summary'),
            start: startDate.toISOString(),
            location: vevent.getFirstPropertyValue('location'),
            description: vevent.getFirstPropertyValue('description'),
            url: null
          });
        }
      }
    }
  }

  // Remove duplicate events (same UID and start time)
  const uniqueEvents = allEventsToPost.filter((event, index, self) =>
    index === self.findIndex(e => e.uid === event.uid && e.start === event.start)
  );

  const dayLabel = uniqueDays.length === 1 
    ? `${uniqueDays[0]} ${uniqueDays[0] === 1 ? 'day' : 'days'}` 
    : `${uniqueDays.join(',')} days`;
  
  if (uniqueEvents.length === 0) {
    return { success: true, message: `${dayLabel}: No events found`, count: 0 };
  }

  for (const event of uniqueEvents) {
    await postToMastodon(env, event);
  }
  
  return { success: true, message: `${dayLabel}: Posted ${uniqueEvents.length} ${uniqueEvents.length === 1 ? 'event' : 'events'}`, count: uniqueEvents.length };
}

async function checkAndPostNextEvent(env) {
  const now = new Date();
  const upcomingLimit = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // Next 14 days

  const { events: rawEvents } = await fetchCalendarEvents(env, 14); // Fetch for 14 days

  const eventsToConsider = [];

  for (const vevent of rawEvents) {
    if (isAllDayOrMultiDay(vevent)) {
      continue;
    }
    const dtstart = vevent.getFirstProperty('dtstart');
    const rruleProp = vevent.getFirstProperty('rrule');

    if (rruleProp) {
      const rruleOptions = RRule.parseString(rruleProp.getFirstValue().toString());
      rruleOptions.dtstart = dtstart.getFirstValue().toJSDate();
      if (dtstart.getFirstValue().timezone) {
        rruleOptions.tzid = dtstart.getFirstValue().timezone;
      }

      const rule = new RRule(rruleOptions);
      const occurrences = rule.between(now, upcomingLimit, true); // Include start and end

      for (const occurrence of occurrences) {
        if (occurrence > now) { // Only consider future occurrences
          eventsToConsider.push({
            uid: vevent.getFirstPropertyValue('uid'),
            summary: vevent.getFirstPropertyValue('summary'),
            start: occurrence.toISOString(),
            location: vevent.getFirstPropertyValue('location'),
            description: vevent.getFirstPropertyValue('description'),
            url: null
          });
        }
      }
    } else {
      const startDate = dtstart.getFirstValue().toJSDate();
      if (startDate > now && startDate < upcomingLimit) {
        eventsToConsider.push({
          uid: vevent.getFirstPropertyValue('uid'),
          summary: vevent.getFirstPropertyValue('summary'),
          start: startDate.toISOString(),
          location: vevent.getFirstPropertyValue('location'),
          description: vevent.getFirstPropertyValue('description'),
          url: null
        });
      }
    }
  }

  // Sort events by start date to find the nearest one
  eventsToConsider.sort((a, b) => new Date(a.start) - new Date(b.start));

  if (eventsToConsider.length === 0) {
    return { success: true, message: "No events found in next 14 days", count: 0 };
  }
  
  const nextEvent = eventsToConsider[0];
  await postToMastodon(env, nextEvent);
  
  return { success: true, message: "Posted next upcoming event", count: 1 };
}

async function getWebEvents(env, days) {
  const { events: rawEvents, debug } = await fetchCalendarEvents(env, days);

  const now = new Date();
  const upcomingLimit = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const eventsToDisplay = [];

  for (const vevent of rawEvents) {
    if (isAllDayOrMultiDay(vevent)) {
      continue;
    }
    const summary = vevent.getFirstPropertyValue('summary');
    const uid = vevent.getFirstPropertyValue('uid');
    const location = vevent.getFirstPropertyValue('location');
    const description = vevent.getFirstPropertyValue('description');
    const url = vevent.getFirstPropertyValue('url');
    const dtstart = vevent.getFirstProperty('dtstart');
    const rruleProp = vevent.getFirstProperty('rrule');

    if (rruleProp) {
      const rruleOptions = RRule.parseString(rruleProp.getFirstValue().toString());
      rruleOptions.dtstart = dtstart.getFirstValue().toJSDate();
      if (dtstart.getFirstValue().timezone) {
        rruleOptions.tzid = dtstart.getFirstValue().timezone;
      }

      const rule = new RRule(rruleOptions);

      const occurrences = rule.between(now, upcomingLimit);

      for (const occurrence of occurrences) {
        eventsToDisplay.push({
          uid: uid,
          summary: summary,
          start: occurrence.toISOString(),
          location: location,
          description: description,
          url: null,
          rrule: rruleProp.getFirstValue().toString()
        });
      }
    } else {
      const startDate = dtstart.getFirstValue().toJSDate();
      if (startDate > now && startDate < upcomingLimit) {
        eventsToDisplay.push({
          uid: uid,
          summary: summary,
          start: startDate.toISOString(),
          location: location,
          description: description,
          url: null,
          rrule: null
        });
      }
    }
  }

  eventsToDisplay.sort((a, b) => new Date(a.start) - new Date(b.start));

  return { events: eventsToDisplay, debug };
}

function getWebInterface(env) {
  // Parse comma-separated days ahead for button text
  const daysAheadStr = env.DAYS_AHEAD || '1';
  const daysArray = daysAheadStr.split(',')
    .map(d => parseInt(d.trim()))
    .filter(d => !isNaN(d) && d >= 0 && d <= 15)
    .slice(0, 4); // Max 4 values
  
  const uniqueDays = [...new Set(daysArray)].sort((a, b) => a - b);
  if (uniqueDays.length === 0) uniqueDays.push(1);
  
  let buttonText;
  if (uniqueDays.length === 1) {
    const day = uniqueDays[0];
    if (day === 0) {
      buttonText = "Post Today\u2019s Events";
    } else if (day === 1) {
      buttonText = "Post Next Day\u2019s Events";
    } else if (day === 2) {
      buttonText = "Post Day After Tomorrow\u2019s Events";
    } else {
      buttonText = `Post Events (+${day} Days)`;
    }
  } else {
    buttonText = `Post Events (${uniqueDays.join(',')} Days)`;
  }
  
  return `
<!DOCTYPE html>
<html>
<head>
    <title>Calendar Bot</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            line-height: 1.6;
            background: #f9f9f9;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
        }
        button {
            background: #1976d2;
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            margin: 10px 10px 10px 0;
            min-width: 160px;
        }
        button:hover {
            background: #1565c0;
        }
        button:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .result {
            margin-top: 20px;
            padding: 15px;
            border-radius: 6px;
            display: none;
        }
        .success {
            background: #e8f5e8;
            color: #2e7d32;
            border: 1px solid #c8e6c9;
        }
        .error {
            background: #ffeaea;
            color: #d32f2f;
            border: 1px solid #ffcdd2;
        }
        .warning {
            background: #fff8e1;
            color: #f57c00;
            border: 1px solid #ffcc02;
        }
        .description {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            font-size: 14px;
        }
        .loading {
            padding: 20px;
            text-align: center;
            color: #666;
            font-style: italic;
        }
        .events-container {
            margin-top: 30px;
        }
        .event-section {
            margin-bottom: 25px;
        }
        .event-section h4 {
            margin-bottom: 15px;
            color: #333;
            border-bottom: 2px solid #1976d2;
            padding-bottom: 5px;
        }
        .event-item {
            background: white;
            border: 1px solid #ddd;
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 10px;
        }
        .event-title {
            font-weight: bold;
            color: #1976d2;
            margin-bottom: 8px;
        }
        .event-time {
            color: #666;
            font-size: 14px;
            margin-bottom: 5px;
            line-height: 1.4;
        }
        .event-time .date-line {
            font-weight: 500;
            color: #333;
            margin-bottom: 3px;
        }
        .event-time .time-line {
            font-family: monospace;
            font-size: 13px;
            color: #555;
        }
        .event-location {
            color: #555;
            font-size: 14px;
            margin-bottom: 5px;
        }
        .next-occurrence {
            background: #e8f5e8;
            color: #2e7d32;
            font-weight: bold;
            padding: 8px 12px;
            border-radius: 6px;
            margin-top: 8px;
            font-size: 13px;
            line-height: 1.4;
        }
        .debug-container pre {
            white-space: pre-wrap;
            word-break: break-all;
            background: #eee;
            padding: 10px;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>CalDAV to Mastodon</h1>
        
        <p><a href="https://github.com/andesco/cloudflare-worker-caldav-to-mastodon">andesco/cloudflare-worker-caldav-to-mastodon</a>
        
        <p>While the serverless function is intended to run automatically (based on a cron schedule) you can also manually post calendar events to Mastodon.
        
        
        <button onclick="triggerNextDay()" id="nextDayBtn">
            ${buttonText}
        </button>
        
        <button onclick="triggerNextEvent()" id="nextEventBtn">
            Post Next Event
        </button>
        
        <div id="result" class="result"></div>
        
        <div id="loading" class="loading">Loading calendar events...</div>
        <div id="eventsContainer" class="events-container" style="display: none;">
            <h3>Calendar Events</h3>
            <div id="recurringEvents" class="event-section"></div>
            <div id="singleEvents" class="event-section"></div>
        </div>

        <div id="debugContainer" class="debug-container" style="display: none;">
            <h3>Debug Information</h3>
            <strong>Export URL:</strong>
            <pre id="propfindResult"></pre>
            <strong>jCal Data:</strong>
            <pre id="eventUrls"></pre>
        </div>
    </div>

    <script>
        function escapeHtml(s) {
            if (!s) return '';
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        }

        let globalEvents = [];
        
        async function triggerNextDay() {
            await triggerEndpoint('/post/day', 'nextDayBtn', 'Next day events');
        }
        
        async function triggerNextEvent() {
            await triggerEndpoint('/post/next', 'nextEventBtn', 'Next event');
        }

        async function postEvent(event) {
            const result = document.getElementById('result');
            result.style.display = 'none';

            try {
                const response = await fetch('/post/event', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(event)
                });
                const text = await response.text();
                
                result.className = response.ok ? 'result success' : 'result error';
                result.textContent = response.ok ?
                    'Event posted successfully' :
                    'Error: ' + text;
                result.style.display = 'block';
            } catch (error) {
                result.className = 'result error';
                result.textContent = 'Network error: ' + error.message;
                result.style.display = 'block';
            }
        }
        
        async function postEventById(index) {
            if (index >= 0 && index < globalEvents.length) {
                await postEvent(globalEvents[index]);
            }
        }
        
        async function triggerEndpoint(endpoint, buttonId, description) {
            const button = document.getElementById(buttonId);
            const result = document.getElementById('result');
            
            button.disabled = true;
            button.textContent = 'Processing...';
            result.style.display = 'none';
            
            try {
                const response = await fetch(endpoint, { method: 'POST' });
                const data = await response.json();
                
                if (response.ok) {
                    if (data.count === 0) {
                        result.className = 'result warning';
                        result.textContent = data.message;
                    } else {
                        result.className = 'result success';
                        result.textContent = data.message;
                    }
                } else {
                    result.className = 'result error';
                    result.textContent = 'Error: ' + data.message;
                }
                result.style.display = 'block';
            } catch (error) {
                result.className = 'result error';
                result.textContent = 'Network error: ' + error.message;
                result.style.display = 'block';
            } finally {
                button.disabled = false;
                button.textContent = buttonId === 'nextDayBtn' ?
                    ${JSON.stringify(buttonText)} :
                    'Post Next Event';
            }
        }
        
        // Load calendar events on page load
        async function loadCalendarEvents() {
            try {
                const response = await fetch('/api/events');
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || 'Failed to load events');
                }
                
                displayEvents(data.events, data.debug);
            } catch (error) {
                document.getElementById('loading').innerHTML =
                    'Error loading events: ' + error.message;
            }
        }
        
        function displayEvents(events, debug) {
            const loading = document.getElementById('loading');
            const container = document.getElementById('eventsContainer');
            const recurringDiv = document.getElementById('recurringEvents');
            const singleDiv = document.getElementById('singleEvents');
            const debugContainer = document.getElementById('debugContainer');
            
            // Store events globally for button access
            globalEvents = events;
            
            loading.style.display = 'none';
            
            if (events.length > 0) {
                container.style.display = 'block';
                const recurringEvents = events.filter(e => e.rrule);
                const singleEvents = events.filter(e => !e.rrule);
                
                // Display recurring events
                if (recurringEvents.length > 0) {
                    recurringDiv.innerHTML = '<h3>Recurring Events</h3>' +
                        recurringEvents.map(event => {
                            const eventIndex = events.indexOf(event);
                            const nextOccurrence = calculateNextOccurrence(event);
                            return '<div class="event-item">' +
                                    '<div class="event-title">' + escapeHtml(event.summary) + '</div>' +
                                    '<div class="event-time">Original:<br>' + formatEventTime(event.start) + '</div>' +
                                    (event.location ? '<div class="event-location">' + escapeHtml(event.location) + '</div>' : '') +
                                    (nextOccurrence ?
                                        '<div class="next-occurrence">Next:<br>' + formatEventTime(nextOccurrence) + '</div>' :
                                        '<div class="next-occurrence">No future occurrences</div>') +
                                    '<button onclick="postEventById(' + eventIndex + ')">Post to Mastodon</button>' +
                                '</div>';
                        }).join('');
                }
                
                // Display single events
                if (singleEvents.length > 0) {
                    const now = new Date();
                    const futureEvents = singleEvents.filter(e => new Date(e.start) > now);
                    const pastEvents = singleEvents.filter(e => new Date(e.start) <= now);
                    
                    singleDiv.innerHTML =
                        [...futureEvents, ...pastEvents].map(event => {
                            const eventIndex = events.indexOf(event);
                            const isFuture = new Date(event.start) > now;
                            return '<div class="event-item">' +
                                    '<div class="event-title">' + escapeHtml(event.summary) + '</div>' +
                                    '<div class="event-time">' + formatEventTime(event.start) + '</div>' +
                                    (event.location ? '<div class="event-location">' + escapeHtml(event.location) + '</div>' : '') +
                                    '<button onclick="postEventById(' + eventIndex + ')">Post to Mastodon</button>' +
                                '</div>';
                        }).join('');
                }
            } else {
                container.innerHTML = '<h3>No Calendar Events Found</h3>';
            }

            if (debug) {
                debugContainer.style.display = 'block';
                document.getElementById('propfindResult').textContent = debug.exportUrl;
                document.getElementById('eventUrls').textContent = JSON.stringify(debug.jcalData, null, 2);
            }
        }
        
        function parseRRule(rrule) {
            const rules = {};
            if (!rrule) return rules;
            const parts = rrule.split(';');
            for (const part of parts) {
                const [key, value] = part.split('=');
                if (key && value) rules[key] = value;
            }
            return rules;
        }
        
        function calculateNextOccurrence(event) {
            if (!event.rrule) return null;
            
            const rules = parseRRule(event.rrule);
            const startDate = new Date(event.start);
            const now = new Date();
            const freq = rules.FREQ;
            const interval = parseInt(rules.INTERVAL || '1');
            
            if (freq === 'WEEKLY') {
                const dayOfWeek = startDate.getDay();
                let nextDate = new Date(now);
                nextDate.setDate(nextDate.getDate() + 1); // Start from tomorrow
                
                // Find next occurrence of this day of the week
                while (nextDate.getDay() !== dayOfWeek) {
                    nextDate.setDate(nextDate.getDate() + 1);
                }
                
                // Apply interval (every N weeks) - calculate from original start date
                if (interval > 1) {
                    const weeksSinceStart = Math.floor((nextDate.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
                    const weeksUntilNext = interval - (weeksSinceStart % interval);
                    if (weeksUntilNext < interval) {
                        nextDate.setDate(nextDate.getDate() + (weeksUntilNext * 7));
                    }
                }
                
                nextDate.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds());
                return nextDate;
            }
            
            if (freq === 'MONTHLY') {
                const byDay = rules.BYDAY;
                const bySetPos = parseInt(rules.BYSETPOS || '1');
                
                if (byDay && bySetPos) {
                    // Handle "3rd Thursday of month" type patterns
                    const dayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
                    const targetDay = dayMap[byDay];
                    
                    let nextDate = new Date(now);
                    nextDate.setDate(1); // Start of current month
                    nextDate.setMonth(nextDate.getMonth() + 1); // Next month
                    
                    // Find the Nth occurrence of the target day
                    let occurrenceCount = 0;
                    while (occurrenceCount < bySetPos) {
                        if (nextDate.getDay() === targetDay) {
                            occurrenceCount++;
                        }
                        if (occurrenceCount < bySetPos) {
                            nextDate.setDate(nextDate.getDate() + 1);
                        }
                    }
                    
                    nextDate.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds());
                    return nextDate;
                }
            }
            
            return null;
        }
        
        function formatEventTime(dateStr) {
            const date = new Date(dateStr);
            
            // Format date (full weekday, abbreviated month with period)
            const laDate = date.toLocaleDateString('en-US', {
                timeZone: 'America/Vancouver',
                weekday: 'long',
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            }).replace(/(\w{3})\s/, '$1. ');
            
            // Format PT time (12-hour, no leading zero)
            const ptTime = date.toLocaleTimeString('en-US', {
                timeZone: 'America/Vancouver',
                hour: 'numeric',
                minute: '2-digit'
            });
            
            // Format ET time (12-hour, no leading zero)
            const etTime = date.toLocaleTimeString('en-US', {
                timeZone: 'America/Toronto',
                hour: 'numeric',
                minute: '2-digit'
            });
            
            // Format UTC time (24-hour)
            const utcTime = date.toLocaleTimeString('en-US', {
                timeZone: 'UTC',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            
            return laDate + '<br>' + ptTime + ' PT | ' + etTime + ' ET | ' + utcTime + ' UTC';
        }
        
        // Load events when page loads
        document.addEventListener('DOMContentLoaded', loadCalendarEvents);
    </script>
</body>
</html>`;
}

async function postToMastodon(env, event) {
  if (!env.MASTODON_INSTANCE_URL || !env.MASTODON_INSTANCE_URL.startsWith('https://')) {
    throw new Error('MASTODON_INSTANCE_URL must be set and use HTTPS');
  }
  const eventDate = new Date(event.start);
  
  // Format date (full weekday, abbreviated month with period)
  const laDate = eventDate.toLocaleDateString('en-US', {
    timeZone: 'America/Vancouver',
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).replace(/(\w{3})\s/, '$1. ');
  
  // Format PT time (12-hour, no leading zero)
  const ptTime = eventDate.toLocaleTimeString('en-US', {
    timeZone: 'America/Vancouver',
    hour: 'numeric',
    minute: '2-digit'
  });
  
  // Format NY time (12-hour, no leading zero)
  const nyTime = eventDate.toLocaleTimeString('en-US', {
    timeZone: 'America/Toronto',
    hour: 'numeric',
    minute: '2-digit'
  });
  
  // Format UTC time (24-hour)
  const utcTime = eventDate.toLocaleTimeString('en-US', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  let status = `Social.\u200Ccoop meetings: https://link.social.coop/calendar\n`;
  status += `${event.summary}\n`;
  status += `${laDate}\n`;
  status += `${ptTime} PT | ${nyTime} ET | ${utcTime} UTC\n`;
  
  if (event.location && !event.location.includes('://') && !event.location.match(/\w+\.\w+\/\w+/)) {
    status += `${event.location}\n`;
  }
  
  // Add footer with line break (\n) to separate from event details
  status += `\nSocial.coop members are welcome to observe this and all upcoming meetings.`;

  // Generate and upload image using external service
  let mediaIds = [];
  try {
    const imageBlob = await generateEventImage(event);
    
    if (imageBlob) {
      const formData = new FormData();
      formData.append('file', imageBlob, 'meeting.png');
      formData.append('description', `${event.summary} on ${laDate}`);

      // Upload image to Mastodon
      const mediaResponse = await fetch(`${env.MASTODON_INSTANCE_URL}/api/v2/media`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.MASTODON_ACCESS_TOKEN}`,
          'User-Agent': 'CalDAV to Mastodon Bot/1.0'
        },
        body: formData
      });

      if (mediaResponse.ok) {
        const mediaResult = await mediaResponse.json();
        mediaIds = [mediaResult.id];
      } else {
        console.error('Failed to upload image to Mastodon:', await mediaResponse.text());
      }
    }
  } catch (error) {
    console.error('Image generation/upload failed:', error);
    // Continue with text-only post
  }

  const mastodonResponse = await fetch(`${env.MASTODON_INSTANCE_URL}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.MASTODON_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'CalDAV to Mastodon Bot/1.0'
    },
    body: JSON.stringify({
      status: status,
      visibility: 'public', // or 'unlisted', 'private', 'direct'
      media_ids: mediaIds
    })
  });

  if (!mastodonResponse.ok) {
    const error = await mastodonResponse.text();
    throw new Error(`Failed to post to Mastodon: ${error}`);
  }

  console.log(`Posted event "${event.summary}" to Mastodon`);
}

async function generateEventImage(event) {
  const eventDate = new Date(event.start);
  
  // Format date (full weekday, abbreviated month with period)
  const laDate = eventDate.toLocaleDateString('en-US', {
    timeZone: 'America/Vancouver',
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).replace(/(\w{3})\s/, '$1. ');
  
  // Format PT time (12-hour, no leading zero)
  const ptTime = eventDate.toLocaleTimeString('en-US', {
    timeZone: 'America/Vancouver',
    hour: 'numeric',
    minute: '2-digit'
  });

  // Create text for image - URL encode special characters
  const title = encodeURIComponent(event.summary);
  const date = encodeURIComponent(laDate);
  const time = encodeURIComponent(`${ptTime} PT`);

  // For now, disable image generation - external services are inconsistent
  // Posts will work perfectly with text content only
  console.log('Image generation disabled - using text-only posts');
  return null;
}
