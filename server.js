require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'pulse-dev-secret-change-in-production';

const OMNI_API_KEY = process.env.OMNI_API_KEY;
const OMNI_BASE_URL = (process.env.OMNI_BASE_URL || '').replace(/\/$/, '');
const OMNI_MODEL_ID = process.env.OMNI_MODEL_ID;
const OMNI_BRANCH_ID = process.env.OMNI_BRANCH_ID;
const OMNI_TOPIC_NAME = process.env.OMNI_TOPIC_NAME;
const OMNI_EMBED_SECRET = process.env.OMNI_EMBED_SECRET || '';
const OMNI_CONTENT_PATH = process.env.OMNI_CONTENT_PATH || '/embed';
const OMNI_EMBED_SSO_URL =
  process.env.OMNI_EMBED_SSO_URL ||
  (OMNI_BASE_URL ? OMNI_BASE_URL.replace(/\/api\/?$/, '') + '/embed/sso/generate-url' : '');

app.use(express.json());

// --- Auth: session + user store (Levi's / Carhartt) ---
const USERS_PATH = path.join(__dirname, '.data', 'users.json');

async function ensureUsersExist() {
  await ensureDataDir();
  let data = await readJsonIfExists(USERS_PATH);
  if (data && Array.isArray(data.users) && data.users.length >= 2) return;
  const defaultPassword = 'password';
  const hash = await bcrypt.hash(defaultPassword, 10);
  data = {
    users: [
      { id: 'carhartt', username: 'carhartt', passwordHash: hash, profile: 'carhartt', displayName: 'Carhartt' },
      { id: 'levis', username: 'levis', passwordHash: hash, profile: 'levis', displayName: "Levi's" },
    ],
  };
  await writeJson(USERS_PATH, data);
}

async function findUserByUsername(username) {
  const data = await readJsonIfExists(USERS_PATH);
  if (!data || !Array.isArray(data.users)) return null;
  const u = String(username || '').trim().toLowerCase();
  return data.users.find((x) => x.username.toLowerCase() === u) || null;
}

/** Call Omni embed SSO API to generate a signed embed URL (and provision embed user for RLS). */
async function generateOmniEmbedUrl({ externalId, name, userAttributes = {} }) {
  if (!OMNI_EMBED_SECRET || !OMNI_EMBED_SSO_URL) {
    return { ok: false, error: 'Embed SSO not configured (OMNI_EMBED_SECRET / OMNI_EMBED_SSO_URL)' };
  }
  const userAttributesJson = JSON.stringify(userAttributes);
  const body = {
    secret: OMNI_EMBED_SECRET,
    contentPath: OMNI_CONTENT_PATH,
    externalId: String(externalId),
    name: String(name),
    userAttributes: encodeURIComponent(userAttributesJson),
  };
  console.log('[embed SSO] request to', OMNI_EMBED_SSO_URL, '| contentPath:', OMNI_CONTENT_PATH, '| externalId:', externalId, '| name:', name, '| userAttributes (raw):', userAttributesJson, '| userAttributes (encoded):', body.userAttributes);
  const res = await fetch(OMNI_EMBED_SSO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  console.log('[embed SSO] response status:', res.status, '| url present:', !!data.url, '| url query (userAttributes):', data.url ? (data.url.includes('userAttributes') ? 'yes' : 'NO') : 'n/a');
  if (data.url) console.log('[embed SSO] full signed URL:', data.url);
  if (!res.ok) {
    return { ok: false, error: data.error || data.message || res.statusText || String(res.status), status: res.status };
  }
  return { ok: true, url: data.url, data };
}

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'pulse.sid',
    cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/api/embed-url') {
    console.log('[embed-url] GET /api/embed-url requested (see server terminal)');
  }
  next();
});

function requireAuth(req, res, next) {
  const allowed =
    (req.path === '/login' && req.method === 'GET') ||
    (req.path === '/api/login' && req.method === 'POST') ||
    req.path === '/api/me';
  if (allowed) return next();
  if (!req.session || !req.session.userId) {
    if (req.path === '/' || req.path === '/index.html') return res.redirect('/login');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(requireAuth);

app.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', express.urlencoded({ extended: true }), async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.redirect('/login?error=missing');
  }
  const user = await findUserByUsername(username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.redirect('/login?error=invalid');
  }
  req.session.userId = user.id;
  req.session.profile = user.profile;
  req.session.displayName = user.displayName;
  req.session.username = user.username;
  const embedResult = await generateOmniEmbedUrl({
    externalId: user.id,
    name: user.displayName,
    userAttributes: { brand: user.displayName, is_internal: 'false' },
  });
  if (embedResult.ok) {
    req.session.omniEmbedUserId = user.id;
    if (embedResult.url) {
      req.session.omniEmbedUrl = embedResult.url;
      console.log('[embed SSO] signed URL for', user.id, ':', embedResult.url);
    }
  } else {
    req.session.omniEmbedUserId = null;
    req.session.omniEmbedUrl = null;
    console.warn('[embed SSO]', embedResult.error, embedResult.status != null ? `(${embedResult.status})` : '');
  }
  res.redirect('/');
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json({
    profile: req.session.profile,
    displayName: req.session.displayName,
    username: req.session.username,
  });
});

app.get('/api/embed-url', async (req, res) => {
  console.log('[embed-url] GET /api/embed-url hit (check server terminal for this log)');
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  // Generate a fresh signed URL on each request; Omni's embed URL is one-time-use, so reusing causes 403.
  const embedResult = await generateOmniEmbedUrl({
    externalId: req.session.userId,
    name: req.session.displayName || req.session.userId,
    userAttributes: { brand: req.session.displayName || req.session.userId, is_internal: 'false' },
  });
  if (!embedResult.ok || !embedResult.url) {
    console.warn('[embed-url] generate failed for', req.session.userId, embedResult.error);
    return res.status(502).json({ error: embedResult.error || 'Could not generate embed URL', url: null });
  }
  console.log('[embed-url] serving fresh URL for', req.session.userId);
  res.set('Cache-Control', 'no-store');
  res.json({ url: embedResult.url });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/login');
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/login');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

// Paths are relative to OMNI_BASE_URL (e.g. https://partners.omniapp.co/api)
const OMNI_API_PREFIX = '/v1/agentic';
const OMNI_QUERY_PREFIX = '/v1/query';

/** Call Omni Queries API (run query, wait for results). Uses resultType: 'json' for easier parsing. */
async function omniQueryRun(query, options = {}) {
  const url = `${OMNI_BASE_URL}${OMNI_QUERY_PREFIX}/run`;
  const body = {
    query: typeof query === 'object' && query !== null ? query : null,
    resultType: 'json',
    ...options.body,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OMNI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (res.status === 408 && data?.remaining_job_ids?.length) {
    const maxWait = 120000; // 2 min
    const step = 2000;
    const end = Date.now() + maxWait;
    let jobIds = data.remaining_job_ids;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, step));
      const waitUrl = `${OMNI_BASE_URL}${OMNI_QUERY_PREFIX}/wait`;
      const waitRes = await fetch(waitUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OMNI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ job_ids: jobIds }),
      });
      const waitText = await waitRes.text();
      let waitData;
      try {
        waitData = waitText ? JSON.parse(waitText) : null;
      } catch {
        waitData = null;
      }
      if (!waitRes.ok) {
        const err = new Error(waitData?.detail || waitData?.message || waitRes.statusText);
        err.status = waitRes.status;
        err.body = waitData;
        throw err;
      }
      if (waitData?.timed_out === false && waitData?.result != null) {
        return waitData;
      }
      if (Array.isArray(waitData?.remaining_job_ids)) jobIds = waitData.remaining_job_ids;
    }
    throw new Error('Query wait timed out');
  }

  if (!res.ok) {
    const msg = data?.detail || data?.message || data?.error || text || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

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

  const maxPolls = 90;
  const pollIntervalMs = 800;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 400 : pollIntervalMs));
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

// --- KPI: Avg Daily Transactions (Omni run-query) ---
const AVG_DAILY_TRANSACTIONS_QUERY = {
  limit: 1000,
  sorts: [{ column_name: 'order_items.created_at[date]', sort_descending: false }],
  table: 'order_items',
  fields: [
    'order_items.created_at[date]',
    'omni_period_pivot',
    'order_items.total_orders',
  ],
  pivots: ['omni_period_pivot'],
  dbtMode: false,
  filters: {
    'order_items.created_at': {
      isFiscal: false,
      is_negative: false,
      kind: 'BETWEEN',
      left_side: 'this month',
      right_side: 'today',
      type: 'date',
      ui_type: 'BETWEEN',
      offset_interval_string: null,
    },
    'order_items.status': {
      kind: 'EQUALS',
      type: 'string',
      values: ['Returned', 'Cancelled'],
      is_negative: true,
    },
  },
  modelId: 'edcfa923-6a47-43a0-9873-ee42624c5d04',
  version: 8,
  rewriteSql: true,
  row_totals: {},
  fill_fields: [],
  calculations: [],
  column_limit: 50,
  join_via_map: {},
  column_totals: { '::total::': { type: 'aggregation' } },
  userEditedSQL: '',
  dimensionIndex: 2,
  default_group_by: true,
  custom_summary_types: {},
  join_paths_from_topic_name: 'order_items',
  period_over_period_computations: [
    { date_filter_field_name: 'order_items.created_at', periods_ago: null, time_unit_name: null },
    { date_filter_field_name: 'order_items.created_at', is_dynamic_previous_period: false, periods_ago: 1, time_unit_name: 'MONTH' },
  ],
};

// --- KPI: Speed of Service (time to ship average) ---
const SPEED_OF_SERVICE_QUERY = {
  column_limit: 50,
  dbtMode: false,
  limit: 1000,
  modelId: 'edcfa923-6a47-43a0-9873-ee42624c5d04',
  rewriteSql: true,
  default_group_by: true,
  userEditedSQL: '',
  calculations: [],
  column_totals: { '::total::': { type: 'aggregation' } },
  custom_summary_types: {},
  dimensionIndex: 2,
  fields: [
    'order_items.created_at[date]',
    'omni_period_pivot',
    'order_items.time_to_ship_average',
  ],
  fill_fields: [],
  filters: {
    'order_items.created_at': {
      isFiscal: false,
      is_negative: false,
      kind: 'BETWEEN',
      left_side: 'this month',
      type: 'date',
      ui_type: 'BETWEEN',
      offset_interval_string: null,
      right_side: 'today',
    },
    'order_items.status': {
      type: 'string',
      kind: 'EQUALS',
      values: ['Returned', 'Cancelled'],
      is_negative: true,
    },
  },
  join_via_map: {},
  pivots: ['omni_period_pivot'],
  row_totals: {},
  sorts: [{ column_name: 'order_items.created_at[date]', sort_descending: false }],
  table: 'order_items',
  version: 8,
  join_paths_from_topic_name: 'order_items',
  period_over_period_computations: [
    { date_filter_field_name: 'order_items.created_at', periods_ago: null, time_unit_name: null },
    { date_filter_field_name: 'order_items.created_at', is_dynamic_previous_period: false, periods_ago: 1, time_unit_name: 'MONTH' },
  ],
};

/** Parse numeric value (Omni time-to-ship is in days) */
function parseDays(val) {
  if (val == null) return NaN;
  const n = typeof val === 'number' ? val : parseFloat(String(val).trim());
  return Number.isNaN(n) ? NaN : n;
}

function parseSpeedOfServiceFromResult(data) {
  let raw = data?.result ?? data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  let rows = Array.isArray(raw) ? raw : (raw?.rows || raw?.data || []);
  if (!Array.isArray(rows) && raw && typeof raw === 'object') {
    const nested = raw.result || raw.data || raw.rows;
    rows = Array.isArray(nested) ? nested : [];
  }
  const columns = raw?.columns;
  if (Array.isArray(columns) && columns.length && Array.isArray(rows) && rows.length && typeof rows[0] !== 'object') {
    rows = rows.map((arr) => {
      const obj = {};
      const colNames = columns.map((c) => (typeof c === 'string' ? c : c?.name ?? c?.id ?? ''));
      colNames.forEach((col, i) => { if (col) obj[col] = arr[i]; });
      return obj;
    });
  }
  if (!rows.length) return null;

  const first = rows[0];
  if (typeof first !== 'object' || first === null) return null;

  const keys = Object.keys(first);
  // Match Omni column names: "Current Period", "Time to Ship Average", "Time To Ship Average", etc.
  const currentKey = keys.find((k) => /current period|time_to_ship|time to ship|ship average/i.test(k));
  const previousKey = keys.find((k) => /previous month|previous period/i.test(k));
  const periodKey = keys.find((k) => /^period$/i.test(k) || /pivot|omni_period/i.test(k));

  if (!currentKey) return null;

  const dataRows = rows.filter((row) => {
    const periodVal = periodKey ? row[periodKey] : '';
    const currentVal = row[currentKey];
    if (typeof currentVal === 'string' && /created at date|total orders/i.test(currentVal)) return false;
    if (typeof periodVal === 'string' && /created at date|total orders/i.test(periodVal.toLowerCase())) return false;
    return true;
  });

  const dailyRows = dataRows.filter((row) => {
    const p = periodKey ? String(row[periodKey] || '').trim() : '';
    const days = parseDays(row[currentKey]);
    return p !== '' && !Number.isNaN(days) && days >= 0;
  });
  const dailyValues = dailyRows.map((row) => parseDays(row[currentKey]));

  const summaryRow = dataRows.find((row) => {
    const p = periodKey ? String(row[periodKey] || '').trim() : '';
    const days = parseDays(row[currentKey]);
    return p === '' && !Number.isNaN(days) && days >= 0;
  });

  let thisPeriodDays = 0;
  let previousPeriodDays = 0;
  if (summaryRow) {
    thisPeriodDays = parseDays(summaryRow[currentKey]);
    previousPeriodDays = previousKey != null ? parseDays(summaryRow[previousKey]) : 0;
  } else {
    for (const row of dataRows) {
      const days = parseDays(row[currentKey]);
      if (Number.isNaN(days)) continue;
      const period = (periodKey ? row[periodKey] : '').toString().toLowerCase();
      if (period.includes('last') || period.includes('previous') || period.includes('prior')) {
        previousPeriodDays += days;
      } else {
        thisPeriodDays += days;
      }
    }
    if (dataRows.length === 1) thisPeriodDays = parseDays(dataRows[0][currentKey]) || 0;
  }

  const valueFormatted = thisPeriodDays < 1
    ? `${(thisPeriodDays * 24).toFixed(1)} hrs avg`
    : `${Number(thisPeriodDays.toFixed(1))} days avg`;
  const diffDays = previousPeriodDays > 0 ? thisPeriodDays - previousPeriodDays : 0;
  let trendFormatted = null;
  if (previousPeriodDays > 0) {
    const sign = diffDays <= 0 ? '' : '+';
    const abs = Math.abs(diffDays);
    const trendStr = abs < 1 ? `${(abs * 24).toFixed(0)}h` : `${abs.toFixed(1)} days`;
    trendFormatted = `${sign}${trendStr} vs last mo.`;
  }

  return {
    valueFormatted,
    valueDays: thisPeriodDays,
    thisPeriodDays,
    previousPeriodDays,
    trendFormatted,
    dailyValues,
    isImprovement: diffDays <= 0,
  };
}

// --- KPI: AOV (average sale price) ---
const AOV_QUERY = {
  column_limit: 50,
  dbtMode: false,
  limit: 1000,
  modelId: 'edcfa923-6a47-43a0-9873-ee42624c5d04',
  rewriteSql: true,
  default_group_by: true,
  userEditedSQL: '',
  calculations: [],
  column_totals: {},
  custom_summary_types: {},
  dimensionIndex: 2,
  fields: [
    'order_items.created_at[date]',
    'omni_period_pivot',
    'order_items.average_sale_price',
  ],
  fill_fields: [],
  filters: {
    'order_items.created_at': {
      isFiscal: false,
      is_negative: false,
      kind: 'BETWEEN',
      left_side: 'this month',
      type: 'date',
      ui_type: 'BETWEEN',
      offset_interval_string: null,
      right_side: 'today',
    },
    'order_items.status': {
      type: 'string',
      kind: 'EQUALS',
      values: ['Returned', 'Cancelled'],
      is_negative: true,
    },
  },
  join_via_map: {},
  pivots: ['omni_period_pivot'],
  row_totals: {},
  sorts: [{ column_name: 'order_items.created_at[date]', sort_descending: false }],
  table: 'order_items',
  version: 8,
  join_paths_from_topic_name: 'order_items',
  period_over_period_computations: [
    { date_filter_field_name: 'order_items.created_at', periods_ago: null, time_unit_name: null },
    { date_filter_field_name: 'order_items.created_at', is_dynamic_previous_period: false, periods_ago: 1, time_unit_name: 'MONTH' },
  ],
};

function parseAovFromResult(data) {
  let raw = data?.result ?? data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  let rows = Array.isArray(raw) ? raw : (raw?.rows || raw?.data || []);
  if (!Array.isArray(rows) && raw && typeof raw === 'object') {
    const nested = raw.result || raw.data || raw.rows;
    rows = Array.isArray(nested) ? nested : [];
  }
  const columns = raw?.columns;
  if (Array.isArray(columns) && columns.length && Array.isArray(rows) && rows.length && typeof rows[0] !== 'object') {
    rows = rows.map((arr) => {
      const obj = {};
      const colNames = columns.map((c) => (typeof c === 'string' ? c : c?.name ?? c?.id ?? ''));
      colNames.forEach((col, i) => { if (col) obj[col] = arr[i]; });
      return obj;
    });
  }
  if (!rows.length) return null;

  const first = rows[0];
  if (typeof first !== 'object' || first === null) return null;

  const keys = Object.keys(first);
  const currentKey = keys.find((k) => /current period|average_sale_price|average sale price/i.test(k));
  const previousKey = keys.find((k) => /previous month|previous period/i.test(k));
  const periodKey = keys.find((k) => /^period$/i.test(k) || /pivot|omni_period/i.test(k));

  if (!currentKey) return null;

  const dataRows = rows.filter((row) => {
    const periodVal = periodKey ? row[periodKey] : '';
    const currentVal = row[currentKey];
    if (typeof currentVal === 'string' && /created at date|total orders/i.test(currentVal)) return false;
    if (typeof periodVal === 'string' && /created at date|total orders/i.test(periodVal.toLowerCase())) return false;
    return true;
  });

  const dailyRows = dataRows.filter((row) => {
    const p = periodKey ? String(row[periodKey] || '').trim() : '';
    const n = Number(row[currentKey]);
    return p !== '' && !Number.isNaN(n) && n >= 0;
  });
  const dailyValues = dailyRows.map((row) => Number(row[currentKey]));

  const summaryRow = dataRows.find((row) => {
    const p = periodKey ? String(row[periodKey] || '').trim() : '';
    const c = Number(row[currentKey]);
    return p === '' && !Number.isNaN(c) && c >= 0;
  });

  let thisPeriod = 0;
  let previousPeriod = 0;
  if (summaryRow) {
    thisPeriod = Number(summaryRow[currentKey]) || 0;
    previousPeriod = previousKey != null ? Number(summaryRow[previousKey]) || 0 : 0;
  } else {
    for (const row of dataRows) {
      const val = Number(row[currentKey]);
      if (Number.isNaN(val)) continue;
      const period = (periodKey ? row[periodKey] : '').toString().toLowerCase();
      if (period.includes('last') || period.includes('previous') || period.includes('prior')) {
        previousPeriod += val;
      } else {
        thisPeriod += val;
      }
    }
    if (dataRows.length === 1) thisPeriod = Number(dataRows[0][currentKey]) || 0;
  }

  const valueFormatted = typeof thisPeriod === 'number' && !Number.isNaN(thisPeriod)
    ? `$${thisPeriod.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
  const pctChange = previousPeriod > 0
    ? ((thisPeriod - previousPeriod) / previousPeriod) * 100
    : 0;
  const sign = pctChange >= 0 ? '+' : '';
  const trendFormatted = previousPeriod > 0 ? `${sign}${pctChange.toFixed(1)}% vs last mo.` : null;

  return {
    valueFormatted,
    value: thisPeriod,
    thisPeriod,
    previousPeriod,
    trendFormatted,
    dailyValues,
    isImprovement: thisPeriod >= previousPeriod,
  };
}

function parseAvgDailyTransactionsFromResult(data) {
  let raw = data?.result ?? data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  let rows = Array.isArray(raw) ? raw : (raw?.rows ? raw.rows : raw?.data ? raw.data : []);
  const columns = raw?.columns;
  // If result is { columns: [...], rows: [[...], ...] }, convert to array of objects
  if (Array.isArray(columns) && columns.length && Array.isArray(rows) && rows.length && typeof rows[0] !== 'object') {
    rows = rows.map((arr) => {
      const obj = {};
      const colNames = columns.map((c) => (typeof c === 'string' ? c : c?.name ?? c?.id ?? ''));
      colNames.forEach((col, i) => { if (col) obj[col] = arr[i]; });
      return obj;
    });
  }
  if (!rows.length) return null;

  const first = rows[0];
  if (typeof first !== 'object' || first === null) return null;

  // Omni JSON can return "Period", "Current Period", "Previous Month" (or similar)
  const currentKey = Object.keys(first).find((k) => /current period|total_orders|total orders/i.test(k));
  const previousKey = Object.keys(first).find((k) => /previous month|previous period/i.test(k));
  const periodKey = Object.keys(first).find((k) => /^period$/i.test(k) || /pivot|omni_period/i.test(k));

  if (!currentKey) return null;

  // Skip header row (e.g. Period: 'Created At Date', Current Period: 'Total Orders')
  const dataRows = rows.filter((row) => {
    const periodVal = periodKey ? row[periodKey] : '';
    const currentVal = row[currentKey];
    if (typeof currentVal === 'string' && /total orders|created at/i.test(currentVal)) return false;
    if (typeof periodVal === 'string' && /created at date|total orders/i.test(periodVal.toLowerCase())) return false;
    return true;
  });

  let thisMonthTotal = 0;
  let lastMonthTotal = 0;

  // Prefer summary row: empty Period and numeric Current Period / Previous Month (last row often)
  const summaryRow = dataRows.find((row) => {
    const p = periodKey ? String(row[periodKey] || '').trim() : '';
    const c = Number(row[currentKey]);
    const prev = previousKey != null ? Number(row[previousKey]) : NaN;
    return p === '' && !Number.isNaN(c) && c > 0;
  });

  // Daily rows for sparkline: exclude header and summary (empty Period)
  const dailyRows = dataRows.filter((row) => {
    const p = periodKey ? String(row[periodKey] || '').trim() : '';
    const c = Number(row[currentKey]);
    return p !== '' && !Number.isNaN(c);
  });
  const dailyValues = dailyRows.map((row) => Number(row[currentKey]));

  if (summaryRow) {
    thisMonthTotal = Number(summaryRow[currentKey]) || 0;
    lastMonthTotal = previousKey != null ? Number(summaryRow[previousKey]) || 0 : 0;
  } else {
    // Sum by period: rows with "previous" in period label -> last month, else current
    for (const row of dataRows) {
      const currentVal = Number(row[currentKey]);
      if (Number.isNaN(currentVal)) continue;
      const period = (periodKey ? row[periodKey] : '').toString().toLowerCase();
      if (period.includes('last') || period.includes('previous') || period.includes('prior')) {
        lastMonthTotal += currentVal;
      } else {
        thisMonthTotal += currentVal;
      }
    }
    if (dataRows.length === 1) thisMonthTotal = Number(dataRows[0][currentKey]) || 0;
  }

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysSoFar = Math.min(dayOfMonth, daysInMonth);
  const avgDaily = daysSoFar > 0 ? Math.round(thisMonthTotal / daysSoFar) : thisMonthTotal;

  let trendFormatted = null;
  if (lastMonthTotal > 0 && thisMonthTotal != null) {
    const pct = (((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100);
    const sign = pct >= 0 ? '+' : '';
    trendFormatted = `${sign}${pct.toFixed(1)}% vs last mo.`;
  }

  return {
    value: avgDaily,
    valueFormatted: avgDaily.toLocaleString(),
    thisMonthTotal,
    lastMonthTotal,
    trendFormatted,
    dailyValues,
  };
}

app.get('/api/kpis/avg-daily-transactions', requireConfig, async (req, res) => {
  try {
    const data = await omniQueryRun(AVG_DAILY_TRANSACTIONS_QUERY);
    const parsed = parseAvgDailyTransactionsFromResult(data);
    if (!parsed) {
      return res.status(502).json({
        error: 'Could not parse KPI from Omni result',
        raw: data?.result != null ? { hasResult: true, rowCount: Array.isArray(data.result) ? data.result.length : 'n/a' } : data,
      });
    }
    res.json(parsed);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || 'Failed to load avg daily transactions';
    res.status(status).json({
      error: message,
      details: err.body,
    });
  }
});

app.get('/api/kpis/speed-of-service', requireConfig, async (req, res) => {
  try {
    const data = await omniQueryRun(SPEED_OF_SERVICE_QUERY);
    const parsed = parseSpeedOfServiceFromResult(data);
    if (!parsed) {
      const raw = data?.result ?? data;
      const rows = Array.isArray(raw) ? raw : (raw?.rows || raw?.data || []);
      const firstRow = rows[0];
      const sampleKeys = typeof firstRow === 'object' && firstRow !== null ? Object.keys(firstRow) : [];
      return res.status(502).json({
        error: 'Could not parse Speed of Service from Omni result',
        debug: { rowCount: rows.length, firstRowKeys: sampleKeys, firstRowSample: firstRow },
      });
    }
    res.json(parsed);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || 'Failed to load speed of service';
    res.status(status).json({
      error: message,
      details: err.body,
    });
  }
});

app.get('/api/kpis/aov', requireConfig, async (req, res) => {
  try {
    const data = await omniQueryRun(AOV_QUERY);
    const parsed = parseAovFromResult(data);
    if (!parsed) {
      return res.status(502).json({
        error: 'Could not parse AOV from Omni result',
        raw: data?.result != null ? { hasResult: true, rowCount: Array.isArray(data.result) ? data.result.length : 'n/a' } : data,
      });
    }
    res.json(parsed);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || 'Failed to load AOV';
    res.status(status).json({
      error: message,
      details: err.body,
    });
  }
});

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

(async () => {
  await ensureUsersExist();
  app.listen(PORT, () => {
    console.log(`Pulse app running at http://localhost:${PORT}`);
    if (!OMNI_API_KEY || !OMNI_BASE_URL || !OMNI_MODEL_ID) {
      console.warn('Warning: Set OMNI_API_KEY, OMNI_BASE_URL, and OMNI_MODEL_ID in .env to use Ask Gleam.');
    }
    if (!process.env.GEMINI_API_KEY) {
    console.warn('Warning: Set GEMINI_API_KEY in .env to use the Gemini coordinator (POST /api/chat).');
  }
});
})();
