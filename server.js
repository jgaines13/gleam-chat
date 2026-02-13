require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const OMNI_API_KEY = process.env.OMNI_API_KEY;
const OMNI_BASE_URL = (process.env.OMNI_BASE_URL || '').replace(/\/$/, '');
const OMNI_MODEL_ID = process.env.OMNI_MODEL_ID;
const OMNI_BRANCH_ID = process.env.OMNI_BRANCH_ID;
const OMNI_TOPIC_NAME = process.env.OMNI_TOPIC_NAME;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Local token storage (prototype) ---
const DATA_DIR = path.join(__dirname, '.data');
const GOOGLE_TOKEN_PATH = path.join(DATA_DIR, 'google_tokens.json');

async function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function writeJson(filePath, value) {
  await ensureDataDir();
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// --- Google Calendar OAuth (prototype, single-user) ---
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

function googleOauthConfigured() {
  return Boolean(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REDIRECT_URI);
}

function buildGoogleAuthUrl() {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json?.error_description || json?.error || 'token exchange failed');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  // Normalize expiry to epoch ms
  const expiry_date = json.expires_in ? Date.now() + (json.expires_in * 1000) : null;
  return { ...json, expiry_date };
}

async function refreshAccessToken(refresh_token) {
  const body = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json?.error_description || json?.error || 'token refresh failed');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  const expiry_date = json.expires_in ? Date.now() + (json.expires_in * 1000) : null;
  return { ...json, expiry_date };
}

async function getGoogleTokens() {
  return await readJsonIfExists(GOOGLE_TOKEN_PATH);
}

async function setGoogleTokens(tokens) {
  await writeJson(GOOGLE_TOKEN_PATH, tokens);
}

async function getValidGoogleAccessToken() {
  const tokens = await getGoogleTokens();
  if (!tokens) {
    const err = new Error('Google Calendar not connected. Click "Connect Calendar" first.');
    err.status = 401;
    throw err;
  }
  const safetyMs = 60_000;
  if (tokens.access_token && tokens.expiry_date && (tokens.expiry_date - safetyMs) > Date.now()) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) {
    const err = new Error('Google Calendar token missing refresh_token. Reconnect Calendar.');
    err.status = 401;
    throw err;
  }
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const merged = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_date: refreshed.expiry_date,
    scope: refreshed.scope || tokens.scope,
    token_type: refreshed.token_type || tokens.token_type,
  };
  await setGoogleTokens(merged);
  return merged.access_token;
}

async function googleCalendarFetch(pathname, { method = 'GET', query, body } = {}) {
  const token = await getValidGoogleAccessToken();
  const base = 'https://www.googleapis.com/calendar/v3';
  const url = new URL(`${base}${pathname}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.reason || json?.error || json?.message || text || res.statusText;
      const err = new Error(msg);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

function requireConfig(req, res, next) {
  if (!OMNI_API_KEY || !OMNI_BASE_URL || !OMNI_MODEL_ID) {
    return res.status(503).json({
      error: 'Server not configured',
      message: 'Set OMNI_API_KEY, OMNI_BASE_URL, and OMNI_MODEL_ID in .env',
    });
  }
  next();
}

// Paths are relative to OMNI_BASE_URL (e.g. https://omni.demo.exploreomni.dev/api)
const OMNI_API_PREFIX = '/v1/agentic';

async function omniFetch(pathname, options = {}) {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = `${OMNI_BASE_URL}${OMNI_API_PREFIX}${path}`;
  const headers = {
    'Authorization': `Bearer ${OMNI_API_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.message || body?.error || (typeof body?.detail === 'string' ? body.detail : null) || text || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Submit a job
app.post('/api/agentic/jobs', requireConfig, async (req, res) => {
  try {
    const { prompt, conversationId, topicName } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required and must be a string' });
    }
    const payload = {
      prompt: prompt.trim(),
      modelId: OMNI_MODEL_ID,
    };
    if (OMNI_BRANCH_ID) payload.branchId = OMNI_BRANCH_ID;
    if (conversationId) payload.conversationId = conversationId;
    if (topicName != null) payload.topicName = String(topicName).slice(0, 256);
    if (OMNI_TOPIC_NAME && !topicName) payload.topicName = OMNI_TOPIC_NAME;

    const result = await omniFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    res.status(201).json(result);
  } catch (err) {
    const status = err.status || 500;
    const details = err.body;
    const message = err.message || 'Failed to submit job';
    res.status(status).json({
      error: message,
      details,
      statusCode: status,
    });
  }
});

// Poll job status
app.get('/api/agentic/jobs/:jobId', requireConfig, async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await omniFetch(`/jobs/${encodeURIComponent(jobId)}`);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Failed to get job status',
      details: err.body,
    });
  }
});

// Get full result (COMPLETE jobs only)
app.get('/api/agentic/jobs/:jobId/result', requireConfig, async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await omniFetch(`/jobs/${encodeURIComponent(jobId)}/result`);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Failed to get result',
      details: err.body,
    });
  }
});

// Cancel job
app.post('/api/agentic/jobs/:jobId/cancel', requireConfig, async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await omniFetch(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || 'Failed to cancel job',
      details: err.body,
    });
  }
});

// --- Gemini coordinator (Omni + Chick-fil-A tools) ---

async function runOmniAnalysis(prompt, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const payload = {
    prompt: String(prompt).trim(),
    modelId: OMNI_MODEL_ID,
  };
  if (OMNI_BRANCH_ID) payload.branchId = OMNI_BRANCH_ID;
  if (OMNI_TOPIC_NAME) payload.topicName = OMNI_TOPIC_NAME;

  onEvent?.({ type: 'omni_submit', modelId: OMNI_MODEL_ID });
  const { jobId } = await omniFetch('/jobs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  onEvent?.({ type: 'omni_job_created', jobId });

  const maxPolls = 60;
  const pollIntervalMs = 2000;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const status = await omniFetch(`/jobs/${jobId}`);
    onEvent?.({ type: 'omni_poll', jobId, state: status.state, progress: status.progress?.message || null });
    if (status.state === 'COMPLETE') {
      const result = await omniFetch(`/jobs/${jobId}/result`);
      onEvent?.({ type: 'omni_complete', jobId });
      const actions = Array.isArray(result.actions) ? result.actions : [];
      const firstQuery =
        actions.find((a) => a?.result?.query)?.result?.query ||
        actions.find((a) => a?.result?.omniQuery)?.result?.omniQuery ||
        null;
      if (firstQuery) {
        onEvent?.({ type: 'omni_query_spec', jobId, query: firstQuery });
      } else {
        onEvent?.({ type: 'omni_query_spec', jobId, query: null });
      }
      return {
        resultSummary: result.resultSummary || 'Analysis complete.',
        querySpec: firstQuery,
      };
    }
    if (status.state === 'FAILED') {
      const errMsg = status.error?.message || 'Omni job failed';
      onEvent?.({ type: 'omni_failed', jobId, error: errMsg });
      throw new Error(errMsg);
    }
    if (status.state === 'CANCELLED') {
      onEvent?.({ type: 'omni_cancelled', jobId });
      throw new Error('Omni job was cancelled');
    }
  }
  onEvent?.({ type: 'omni_timeout', jobId });
  throw new Error('Omni job timed out');
}

// --- Weather tool (external, not Omni) ---
async function weatherGetForecast(location, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const hours = Math.max(1, Math.min(48, Number(opts.hours || 12)));
  const q = String(location || '').trim();
  if (!q) throw new Error('weather: location is required');

  const US_STATE = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
    TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
    WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  };

  function parseCityState(input) {
    const m = input.match(/^(.+?),\s*([A-Za-z]{2})\s*$/);
    if (!m) return { city: input, stateCode: null, stateName: null };
    const city = m[1].trim();
    const stateCode = m[2].toUpperCase();
    return { city, stateCode, stateName: US_STATE[stateCode] || null };
  }

  async function geocodeOpenMeteo(name, { count = 10, countryCode } = {}) {
    const base = 'https://geocoding-api.open-meteo.com/v1/search';
    const params = new URLSearchParams({
      name,
      count: String(count),
      format: 'json',
    });
    if (countryCode) params.set('country_code', countryCode);
    const url = `${base}?${params.toString()}`;
    const geo = await fetchJson(url, { timeoutMs: 10000 });
    return { url, results: geo?.results || [] };
  }

  const { city, stateCode, stateName } = parseCityState(q);
  onEvent?.({ type: 'weather_geocode_start', location: q, parsed: { city, stateCode, stateName }, source: 'Open-Meteo' });

  // Attempt 1: raw query
  let attempt = 1;
  let { url: geoUrl, results } = await geocodeOpenMeteo(q, { count: 10, countryCode: 'US' });
  onEvent?.({ type: 'weather_geocode_attempt', attempt, url: geoUrl, resultsCount: results.length });

  // Attempt 2: city-only if raw failed (handles inputs like "Atlanta, GA")
  if (!results.length && city && city !== q) {
    attempt = 2;
    const out = await geocodeOpenMeteo(city, { count: 10, countryCode: 'US' });
    geoUrl = out.url;
    results = out.results;
    onEvent?.({ type: 'weather_geocode_attempt', attempt, url: geoUrl, resultsCount: results.length });
  }

  // If we have a state, prefer a match on admin1.
  let best = results[0];
  if (stateName && results.length) {
    best = results.find((r) => String(r.admin1 || '').toLowerCase() === stateName.toLowerCase()) || best;
  }

  if (!best) throw new Error(`weather: could not find location "${q}"`);

  const latitude = best.latitude;
  const longitude = best.longitude;
  const resolved = [best.name, best.admin1, best.country].filter(Boolean).join(', ');
  onEvent?.({ type: 'weather_geocode_ok', resolved, latitude, longitude, pickedFrom: results.length });

  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}` +
    `&longitude=${encodeURIComponent(longitude)}` +
    `&timezone=auto` +
    `&current=temperature_2m,precipitation,wind_speed_10m` +
    `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m` +
    `&forecast_days=2`;
  onEvent?.({ type: 'weather_forecast_start', url: 'open-meteo:forecast', hours });
  const fc = await fetchJson(forecastUrl, { timeoutMs: 12000 });
  onEvent?.({ type: 'weather_forecast_ok', timezone: fc?.timezone || null });

  // Build a small next-hours view
  const times = fc?.hourly?.time || [];
  const temp = fc?.hourly?.temperature_2m || [];
  const pop = fc?.hourly?.precipitation_probability || [];
  const precip = fc?.hourly?.precipitation || [];
  const wind = fc?.hourly?.wind_speed_10m || [];

  const nowIso = fc?.current?.time;
  const startIdx = nowIso ? Math.max(0, times.indexOf(nowIso)) : 0;
  const endIdx = Math.min(times.length, startIdx + hours);

  const hourly = [];
  for (let i = startIdx; i < endIdx; i++) {
    hourly.push({
      time: times[i],
      temperature_2m: temp[i],
      precipitation_probability: pop[i],
      precipitation: precip[i],
      wind_speed_10m: wind[i],
    });
  }

  return {
    source: 'Open-Meteo Weather API',
    location: { input: q, resolved, latitude, longitude },
    timezone: fc?.timezone || null,
    current: fc?.current || null,
    hourly,
    units: fc?.hourly_units || null,
    fetchedAt: new Date().toISOString(),
  };
}

// Quick health check / debug endpoint for weather tool (bypasses Gemini)
app.get('/api/tools/weather', async (req, res) => {
  try {
    const location = String(req.query.location || '').trim();
    const hours = req.query.hours != null ? Number(req.query.hours) : 12;
    const out = await weatherGetForecast(location, { hours });
    res.json(out);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'weather failed' });
  }
});

// --- Google Calendar OAuth + tool endpoints ---

app.get('/api/tools/calendar/status', async (req, res) => {
  const tokens = await getGoogleTokens();
  res.json({
    configured: googleOauthConfigured(),
    connected: Boolean(tokens?.refresh_token || tokens?.access_token),
    hasRefreshToken: Boolean(tokens?.refresh_token),
  });
});

app.get('/auth/google', (req, res) => {
  if (!googleOauthConfigured()) {
    return res.status(503).send('Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI in .env.');
  }
  return res.redirect(buildGoogleAuthUrl());
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!googleOauthConfigured()) {
      return res.status(503).send('Google OAuth not configured.');
    }
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing code.');

    const tokens = await exchangeCodeForTokens(code);
    const existing = await getGoogleTokens();
    // Google may not return refresh_token on subsequent consents; preserve existing.
    const merged = {
      ...(existing || {}),
      ...tokens,
      refresh_token: tokens.refresh_token || existing?.refresh_token || null,
    };
    await setGoogleTokens(merged);

    return res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Calendar Connected</title></head>
<body style="font-family: system-ui; padding: 24px;">
  <h2>Google Calendar connected</h2>
  <p>You can close this window and return to Pulse.</p>
</body></html>`);
  } catch (err) {
    return res.status(err?.status || 500).send(`OAuth error: ${err?.message || 'unknown'}`);
  }
});

app.get('/api/tools/calendar/events', async (req, res) => {
  try {
    const calendarId = String(req.query.calendarId || 'primary');
    const timeMin = String(req.query.timeMin || new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const timeMax = String(req.query.timeMax || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString());
    const q = req.query.q != null ? String(req.query.q) : undefined;
    const maxResults = req.query.maxResults != null ? Number(req.query.maxResults) : 10;

    const out = await googleCalendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        timeMin,
        timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults,
        q,
      },
    });
    res.json({
      source: 'Google Calendar API',
      calendarId,
      timeMin,
      timeMax,
      items: out.items || [],
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'calendar list failed', details: err?.body });
  }
});

app.post('/api/tools/calendar/events', async (req, res) => {
  try {
    const {
      calendarId = 'primary',
      summary,
      description,
      location,
      startIso,
      endIso,
      attendees,
    } = req.body || {};
    if (!summary || !startIso || !endIso) {
      return res.status(400).json({ error: 'summary, startIso, and endIso are required' });
    }

    const event = {
      summary,
      description,
      location,
      start: { dateTime: startIso },
      end: { dateTime: endIso },
      attendees: Array.isArray(attendees) ? attendees.map((email) => ({ email })) : undefined,
    };

    const created = await googleCalendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: event,
    });

    res.json({
      source: 'Google Calendar API',
      calendarId,
      event: created,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || 'calendar create failed', details: err?.body });
  }
});

// Gemini tool handlers (use Calendar API under the hood)
async function calendarListEvents(args = {}, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const calendarId = String(args.calendarId || 'primary');
  const timeMin = String(args.timeMin || new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const timeMax = String(args.timeMax || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString());
  const q = args.q != null ? String(args.q) : undefined;
  const maxResults = args.maxResults != null ? Number(args.maxResults) : 10;

  onEvent?.({ type: 'calendar_list_start', calendarId, timeMin, timeMax, maxResults, q, source: 'Google Calendar API' });
  const out = await googleCalendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    query: {
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults,
      q,
    },
  });
  const items = out.items || [];
  onEvent?.({ type: 'calendar_list_ok', count: items.length, source: 'Google Calendar API' });
  return {
    source: 'Google Calendar API',
    calendarId,
    timeMin,
    timeMax,
    items,
    fetchedAt: new Date().toISOString(),
  };
}

async function calendarCreateEvent(args = {}, opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
  const calendarId = String(args.calendarId || 'primary');
  const summary = String(args.summary || '');
  const description = args.description != null ? String(args.description) : undefined;
  const location = args.location != null ? String(args.location) : undefined;
  const startIso = String(args.startIso || args.start || '');
  const endIso = String(args.endIso || args.end || '');
  const attendees = Array.isArray(args.attendees) ? args.attendees.map(String) : [];

  if (!summary || !startIso || !endIso) {
    const err = new Error('calendar_create_event requires summary, startIso, endIso');
    err.status = 400;
    throw err;
  }

  onEvent?.({ type: 'calendar_create_start', calendarId, summary, startIso, endIso, attendeesCount: attendees.length, source: 'Google Calendar API' });
  const event = {
    summary,
    description,
    location,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
    attendees: attendees.length ? attendees.map((email) => ({ email })) : undefined,
  };
  const created = await googleCalendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: event,
  });
  onEvent?.({ type: 'calendar_create_ok', eventId: created?.id || null, htmlLink: created?.htmlLink || null, source: 'Google Calendar API' });
  return {
    source: 'Google Calendar API',
    calendarId,
    event: created,
    createdAt: new Date().toISOString(),
  };
}

let coordinator = null;
function getCoordinator() {
  const provider = process.env.GEMINI_PROVIDER || 'developer';
  if (provider === 'vertex') {
    const project = process.env.GEMINI_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.GEMINI_VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION;
    if (!project || !location) return null;
  } else {
    if (!process.env.GEMINI_API_KEY) return null;
  }
  if (!coordinator) {
    try {
      // Lazily require so Omni-only mode works without Gemini deps installed.
      const { createCoordinator } = require('./lib/coordinator');
      coordinator = createCoordinator({
        runOmniAnalysis: (prompt) => runOmniAnalysis(prompt),
        weatherGetForecast: (location, opts) => weatherGetForecast(location, opts),
        calendarListEvents: (args, opts) => calendarListEvents(args, opts),
        calendarCreateEvent: (args, opts) => calendarCreateEvent(args, opts),
        provider: process.env.GEMINI_PROVIDER || 'developer',
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        vertexProject: process.env.GEMINI_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
        vertexLocation: process.env.GEMINI_VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION,
      });
    } catch (err) {
      // Most common: missing dependency (@google/genai) because npm install hasn't been re-run.
      console.error('Failed to initialize Gemini coordinator:', err?.message || err);
      return null;
    }
  }
  return coordinator;
}

// --- Simple chat throttling (helps avoid 429s on free/dev Gemini API) ---
// Global queue + single concurrency is enough for a prototype.
const CHAT_MAX_CONCURRENT = Number(process.env.CHAT_MAX_CONCURRENT || 1);
const CHAT_QUEUE_LIMIT = Number(process.env.CHAT_QUEUE_LIMIT || 10);
let chatInFlight = 0;
const chatQueue = [];

// --- Conversation memory (prototype, in-memory) ---
// Stores Gemini conversation history by conversationId so the chat is context-aware.
const CHAT_MEMORY_TTL_MS = Number(process.env.CHAT_MEMORY_TTL_MS || (2 * 60 * 60 * 1000)); // 2 hours
const CHAT_MEMORY_MAX_ITEMS = Number(process.env.CHAT_MEMORY_MAX_ITEMS || 60);
const chatMemory = new Map(); // conversationId -> { history, updatedAt }

function getConversationId(maybeId) {
  if (typeof maybeId === 'string' && maybeId.trim()) return maybeId.trim();
  return crypto.randomUUID();
}

function loadHistory(conversationId) {
  const entry = chatMemory.get(conversationId);
  if (!entry) return [];
  if ((Date.now() - entry.updatedAt) > CHAT_MEMORY_TTL_MS) {
    chatMemory.delete(conversationId);
    return [];
  }
  return Array.isArray(entry.history) ? entry.history : [];
}

function saveHistory(conversationId, history) {
  const arr = Array.isArray(history) ? history : [];
  const trimmed = arr.length > CHAT_MEMORY_MAX_ITEMS ? arr.slice(-CHAT_MEMORY_MAX_ITEMS) : arr;
  chatMemory.set(conversationId, { history: trimmed, updatedAt: Date.now() });
}

function enqueueChat(fn) {
  return new Promise((resolve, reject) => {
    if (chatQueue.length >= CHAT_QUEUE_LIMIT) {
      const err = new Error('Chat queue is full. Please wait a moment and try again.');
      err.status = 429;
      reject(err);
      return;
    }
    chatQueue.push({ fn, resolve, reject });
    drainChatQueue();
  });
}

async function drainChatQueue() {
  if (chatInFlight >= CHAT_MAX_CONCURRENT) return;
  const item = chatQueue.shift();
  if (!item) return;
  chatInFlight++;
  try {
    const result = await item.fn();
    item.resolve(result);
  } catch (e) {
    item.reject(e);
  } finally {
    chatInFlight--;
    // Small delay prevents immediate re-bursting
    setTimeout(drainChatQueue, 250);
  }
}

app.get('/api/chat/config', (req, res) => {
  const provider = process.env.GEMINI_PROVIDER || 'developer';
  res.json({
    provider,
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    hasGeminiApiKey: Boolean(process.env.GEMINI_API_KEY),
    vertexProject: process.env.GEMINI_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null,
    vertexLocation: process.env.GEMINI_VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || null,
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationId: incomingConversationId, debug } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required and must be a string' });
    }
    const coord = getCoordinator();
    if (!coord) {
      return res.status(503).json({
        error: 'Chat not configured',
        message: 'Configure Gemini and run `npm install` (needs @google/genai) to use the coordinator.',
      });
    }
    const conversationId = getConversationId(incomingConversationId);
    const history = loadHistory(conversationId);
    const trace = [];
    const onEvent = debug
      ? (evt) => trace.push({ ts: new Date().toISOString(), ...evt })
      : null;
    const { reply, history: newHistory } = await enqueueChat(() => coord.chat(message.trim(), history, { onEvent }));
    saveHistory(conversationId, newHistory);
    res.json({ reply, conversationId, debug: debug ? trace : undefined });
  } catch (err) {
    console.error('Chat error:', err);
    const msg = err?.message || 'Chat failed';
    const status = err?.status === 429 || /RESOURCE_EXHAUSTED|Resource exhausted/i.test(msg) ? 429 : 500;
    res.status(status).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Pulse app running at http://localhost:${PORT}`);
  if (!OMNI_API_KEY || !OMNI_BASE_URL || !OMNI_MODEL_ID) {
    console.warn('Warning: Set OMNI_API_KEY, OMNI_BASE_URL, and OMNI_MODEL_ID in .env to use Ask Pulse.');
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn('Warning: Set GEMINI_API_KEY in .env to use the Gemini coordinator (POST /api/chat).');
  }
});
