/**
 * Gemini coordinator: chat with tool use (Omni, Chick-fil-A tools).
 * Loops until Gemini returns a text-only response.
 */

const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');

const SYSTEM_INSTRUCTION = `You are Pulse, the AI assistant for Chick-fil-A operators in the Southeast Region.
You help with locations, performance, operations, and data analysis.
Use the tools when the user asks for data, analysis, or actions:
- For questions about data, metrics, trends, or "run analysis" use run_omni_analysis.
- For finding locations use chickfila_find_locations.
- For operator metrics use chickfila_operator_metrics.
 - For weather and conditions use weather_get_forecast (external Weather API).
 - For scheduling and meetings use calendar_list_events / calendar_create_event (Google Calendar API).
When the user asks to schedule a "shift", the calendar event title must be "Shift for [name]" where [name] is the person they are scheduling the shift for (e.g. "schedule a shift for Ben" → title "Shift for Ben"). If they do not specify a name, ask who the shift is for before creating events.
When run_omni_analysis returns a result, you will not be asked to summarize it—the exact Omni response is shown to the user. For other tools, respond as usual.
Rules:
- If the user asks about weather/forecast/temperature/rain/wind, ALWAYS call weather_get_forecast (do not send weather-only questions to Omni).
- If the user asks a combined question (weather + business metrics), call weather_get_forecast first, then run_omni_analysis if needed, and combine results clearly.
- If the user asks about business metrics like revenue, sales, transactions, orders, or performance (and is NOT asking about weather), do NOT call weather_get_forecast. Use run_omni_analysis.
Respond in a clear, concise way. Format answers with markdown when helpful (lists, bold, etc.).`;

function getCurrentDateContext() {
  const now = new Date();
  const iso = now.toISOString();
  const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `Current date and time (use this for "today", "this Saturday", "next 3 weeks", etc.): Today is ${dayName}, ${dateStr}. Time: ${timeStr}. ISO: ${iso}.`;
}

const TOOL_DECLARATIONS = [
  {
    name: 'run_omni_analysis',
    description: 'Run a natural-language data or analysis question against Omni. Use this when the operator asks about metrics, trends, reports, seasonality, transactions, satisfaction, speed of service, or any analytical question about their business data.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The analysis question or request in natural language (e.g. "Seasonality trends in orders?", "Top locations by transactions")',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'chickfila_find_locations',
    description: 'Find Chick-fil-A restaurant locations. Use when the operator asks to find locations, nearest store, or search by address/region.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query: address, city, region name, or "nearest"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'chickfila_operator_metrics',
    description: 'Get operator or location metrics (e.g. satisfaction scores, KPIs). Use when the operator asks for operator satisfaction, location performance, or regional metrics.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        metric_type: {
          type: 'string',
          description: 'Type of metrics: "satisfaction", "performance", "regional"',
        },
      },
      required: ['metric_type'],
    },
  },
  {
    name: 'weather_get_forecast',
    description: 'Get current conditions and a short hourly forecast for a given location using an external Weather API (not Omni). Only use when the user is asking about weather (rain/temperature/wind/forecast). Requires a location.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City/region/address (e.g. \"Atlanta, GA\" or \"Buckhead Atlanta\")',
        },
        hours: {
          type: 'number',
          description: 'How many hours ahead to include (default 12, max 48)',
        },
      },
      required: ['location'],
    },
  },
  {
    name: 'calendar_list_events',
    description: 'List upcoming events from Google Calendar (external tool). Use when the operator asks about meetings, schedule, calendar, or what’s on the agenda.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
        timeMin: { type: 'string', description: 'RFC3339 start time (inclusive)' },
        timeMax: { type: 'string', description: 'RFC3339 end time (exclusive)' },
        q: { type: 'string', description: 'Free-text search query (optional)' },
        maxResults: { type: 'number', description: 'Max events to return (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create a Google Calendar event (external tool). Use when the operator asks to schedule a meeting or create an event.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
        summary: { type: 'string', description: 'Event title/summary' },
        description: { type: 'string', description: 'Event description (optional)' },
        location: { type: 'string', description: 'Event location (optional)' },
        startIso: { type: 'string', description: 'Start time in RFC3339 (e.g. 2026-02-12T15:00:00-05:00)' },
        endIso: { type: 'string', description: 'End time in RFC3339' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee emails (optional)' },
      },
      required: ['summary', 'startIso', 'endIso'],
    },
  },
];

/**
 * @param {Object} options
 * @param {Function} options.runOmniAnalysis - (prompt: string) => Promise<{ resultSummary: string }>
 * @param {Function} [options.chickfilaFindLocations] - (query: string) => Promise<object>
 * @param {Function} [options.chickfilaOperatorMetrics] - (metricType: string) => Promise<object>
 * @param {string} [options.apiKey] - GEMINI_API_KEY
 * @param {string} [options.model] - e.g. 'gemini-2.0-flash'
 */
function createCoordinator(options) {
  const {
    runOmniAnalysis,
    chickfilaFindLocations = stubChickfilaFindLocations,
    chickfilaOperatorMetrics = stubChickfilaOperatorMetrics,
    weatherGetForecast = stubWeatherGetForecast,
    calendarListEvents = stubCalendarListEvents,
    calendarCreateEvent = stubCalendarCreateEvent,
    provider = process.env.GEMINI_PROVIDER || 'developer', // 'developer' | 'vertex'
    apiKey = process.env.GEMINI_API_KEY,
    model = process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    vertexProject = process.env.GEMINI_VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    vertexLocation = process.env.GEMINI_VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION,
  } = options;

  let ai;
  if (provider === 'vertex') {
    if (!vertexProject || !vertexLocation) {
      throw new Error('Vertex Gemini requires GEMINI_VERTEX_PROJECT and GEMINI_VERTEX_LOCATION (or GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION).');
    }
    ai = new GoogleGenAI({
      vertexai: true,
      project: vertexProject,
      location: vertexLocation,
    });
  } else {
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required for the coordinator (developer mode).');
    }
    ai = new GoogleGenAI({ apiKey });
  }

  async function generateWithRetry({ model, contents, config }) {
    const maxAttempts = 4;
    let delayMs = 800;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await ai.models.generateContent({ model, contents, config });
      } catch (err) {
        const status = err?.status || err?.code || err?.error?.code;
        const msg = err?.message || err?.error?.message || String(err);
        const isRateLimit = status === 429 || /RESOURCE_EXHAUSTED|Resource exhausted/i.test(msg);
        if (!isRateLimit || attempt === maxAttempts) throw err;
        const jitter = Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, delayMs + jitter));
        delayMs *= 2;
      }
    }
    // Unreachable, but keep TypeScript/linters happy if added later.
    return await ai.models.generateContent({ model, contents, config });
  }

  /**
   * Run one chat turn: user message + optional history, with tool loop.
   * @param {string} userMessage
   * @param {Array} conversationHistory - optional list of { role, parts } for multi-turn
   * @param {Object} [opts]
   * @param {(event: object) => void} [opts.onEvent]
   * @returns {Promise<{ reply: string, history: Array }>}
   */
  async function chat(userMessage, conversationHistory = [], opts = {}) {
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    const contents = [
      ...conversationHistory,
      { role: 'user', parts: [{ text: userMessage }] },
    ];

    const wantsWeather = messageWantsWeather(userMessage);
    const wantsOmni = messageWantsOmni(userMessage);
    const isCombined = wantsWeather && wantsOmni;
    let weatherCompleted = false;
    let omniCompleted = false;

    function buildConfig({ forceWeatherOnly } = {}) {
      const dateContext = getCurrentDateContext();
      const base = {
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        systemInstruction: SYSTEM_INSTRUCTION + '\n\n' + dateContext,
      };
      // If weather is mentioned, force a weather tool call on the first step.
      if (forceWeatherOnly) {
        return {
          ...base,
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: ['weather_get_forecast'],
            },
          },
        };
      }
      // If it's a business-metrics question and not weather, force Omni first.
      if (wantsOmni && !wantsWeather && !omniCompleted) {
        return {
          ...base,
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: ['run_omni_analysis'],
            },
          },
        };
      }
      // For combined questions, force Omni after weather has completed.
      if (isCombined && weatherCompleted && !omniCompleted) {
        return {
          ...base,
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: ['run_omni_analysis'],
            },
          },
        };
      }
      return base;
    }

    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      const config = wantsWeather && !weatherCompleted
        ? buildConfig({ forceWeatherOnly: true })
        : buildConfig();

      onEvent?.({
        type: 'gemini_request',
        iteration: iterations + 1,
        model,
        forcedWeatherStep: Boolean(wantsWeather && !weatherCompleted),
        forcedOmniStep: Boolean(isCombined && weatherCompleted && !omniCompleted),
        isCombined,
      });
      const result = await generateWithRetry({ model, contents, config });

      // Text response (no tool calls)
      const text = result.text;
      let functionCalls = result.functionCalls || [];
      if (functionCalls.length === 0 && result.candidates?.[0]?.content?.parts) {
        functionCalls = result.candidates[0].content.parts
          .filter((p) => p.functionCall || p.function_call)
          .map((p) => {
            const fc = p.functionCall || p.function_call;
            return { name: fc.name, args: fc.args || {} };
          });
      }

      if (functionCalls.length === 0) {
        const reply = (text && String(text).trim()) || 'No response generated.';
        onEvent?.({ type: 'gemini_response_text', iteration: iterations + 1, preview: reply.slice(0, 200) });
        // Preserve model turn in history so subsequent requests have context
        const candidate = result.candidates?.[0];
        const modelParts = candidate?.content?.parts || [];
        if (modelParts.length) {
          contents.push({ role: 'model', parts: modelParts });
        } else if (reply) {
          contents.push({ role: 'model', parts: [{ text: reply }] });
        }
        return { reply, history: contents };
      }
      onEvent?.({
        type: 'gemini_function_calls',
        iteration: iterations + 1,
        calls: functionCalls.map((c) => ({ name: c.name, args: c.args })),
      });

      // Append model turn to history (so Gemini has context)
      const candidate = result.candidates?.[0];
      const modelParts = candidate?.content?.parts || [];
      if (modelParts.length) {
        contents.push({ role: 'model', parts: modelParts });
      }

      let lastOmniResultSummary = null;
      const toolHandlers = {
        run_omni_analysis: async (args) => {
          const prompt = args?.prompt || '';
          onEvent?.({ type: 'tool_start', tool: 'run_omni_analysis', promptPreview: String(prompt).slice(0, 200) });
          const result = await runOmniAnalysis(prompt, { onEvent });
          const summary = result?.resultSummary || result?.summary || String(result);
          lastOmniResultSummary = summary;
          onEvent?.({ type: 'tool_end', tool: 'run_omni_analysis', resultPreview: String(summary).slice(0, 200) });
          return { resultSummary: summary, querySpec: result?.querySpec || null };
        },
        chickfila_find_locations: async (args) => {
          const query = args?.query || '';
          onEvent?.({ type: 'tool_start', tool: 'chickfila_find_locations', query });
          const out = await chickfilaFindLocations(query);
          onEvent?.({ type: 'tool_end', tool: 'chickfila_find_locations', resultPreview: JSON.stringify(out).slice(0, 200) });
          return out;
        },
        chickfila_operator_metrics: async (args) => {
          const metric_type = args?.metric_type || 'satisfaction';
          onEvent?.({ type: 'tool_start', tool: 'chickfila_operator_metrics', metric_type });
          const out = await chickfilaOperatorMetrics(metric_type);
          onEvent?.({ type: 'tool_end', tool: 'chickfila_operator_metrics', resultPreview: JSON.stringify(out).slice(0, 200) });
          return out;
        },
        weather_get_forecast: async (args) => {
          const location = args?.location || '';
          const hours = Math.max(1, Math.min(48, Number(args?.hours || 12)));
          onEvent?.({ type: 'tool_start', tool: 'weather_get_forecast', location, hours, source: 'Open-Meteo' });
          try {
            const out = await weatherGetForecast(location, { hours, onEvent });
            onEvent?.({ type: 'tool_end', tool: 'weather_get_forecast', resultPreview: JSON.stringify(out).slice(0, 200), source: out?.source || 'weather' });
            return out;
          } catch (err) {
            const msg = err?.message || 'Weather tool failed';
            onEvent?.({ type: 'tool_error', tool: 'weather_get_forecast', error: msg, location, hours, source: 'Open-Meteo' });
            return {
              source: 'Open-Meteo Weather API',
              error: msg,
              location,
              hours,
            };
          }
        },
        calendar_list_events: async (args) => {
          onEvent?.({ type: 'tool_start', tool: 'calendar_list_events', source: 'Google Calendar API' });
          try {
            const out = await calendarListEvents(args, { onEvent });
            onEvent?.({ type: 'tool_end', tool: 'calendar_list_events', resultPreview: JSON.stringify(out).slice(0, 200), source: out?.source || 'Google Calendar API' });
            return out;
          } catch (err) {
            const msg = err?.message || 'Calendar list failed';
            onEvent?.({ type: 'tool_error', tool: 'calendar_list_events', error: msg, source: 'Google Calendar API' });
            return { source: 'Google Calendar API', error: msg };
          }
        },
        calendar_create_event: async (args) => {
          onEvent?.({ type: 'tool_start', tool: 'calendar_create_event', source: 'Google Calendar API' });
          try {
            const out = await calendarCreateEvent(args, { onEvent });
            onEvent?.({ type: 'tool_end', tool: 'calendar_create_event', resultPreview: JSON.stringify(out).slice(0, 200), source: out?.source || 'Google Calendar API' });
            return out;
          } catch (err) {
            const msg = err?.message || 'Calendar create failed';
            onEvent?.({ type: 'tool_error', tool: 'calendar_create_event', error: msg, source: 'Google Calendar API' });
            return { source: 'Google Calendar API', error: msg };
          }
        },
      };

      // Execute each function call and send results back
      for (const fc of functionCalls) {
        const name = fc.name;
        const args = fc.args || {};
        const handler = toolHandlers[name];
        let responseData;
        if (handler) {
          try {
            responseData = await handler(args);
          } catch (err) {
            responseData = { error: err.message || 'Tool execution failed' };
          }
        } else {
          responseData = { error: `Unknown tool: ${name}` };
        }
        if (name === 'weather_get_forecast') weatherCompleted = true;
        if (name === 'run_omni_analysis') omniCompleted = true;
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response: responseData } }],
        });
      }

      // When the only tool call was run_omni_analysis, return the exact Omni response (no Gemini summary).
      if (functionCalls.length === 1 && functionCalls[0].name === 'run_omni_analysis' && lastOmniResultSummary != null) {
        const reply = String(lastOmniResultSummary).trim() || 'No analysis result returned.';
        onEvent?.({ type: 'gemini_response_text', passthrough: 'omni_exact', iteration: iterations + 1 });
        contents.push({ role: 'model', parts: [{ text: reply }] });
        return { reply, history: contents };
      }

      iterations++;
    }

    return { reply: 'I hit the maximum number of steps. Please try a shorter question.', history: contents };
  }

  return { chat };
}

function messageWantsWeather(message) {
  const m = String(message || '').toLowerCase();
  const weatherTerms = [
    'weather', 'forecast', 'rain', 'storm', 'snow', 'temperature', 'temp', 'wind',
    'precip', 'humidity', 'heat', 'cold', 'hot', 'freezing', 'thunder', 'lightning',
  ];
  return weatherTerms.some((t) => m.includes(t));
}

function messageWantsOmni(message) {
  const m = String(message || '').toLowerCase();
  const omniTerms = [
    'orders', 'order volume', 'transactions', 'sales', 'revenue',
    'speed of service', 'drive-thru', 'drive thru', 'throughput',
    'guest satisfaction', 'csat', 'nps', 'operator satisfaction',
    'trend', 'compare', 'impact', 'delta', 'lift', 'drop', 'increase', 'decrease',
    'yoy', 'week over week', 'month over month', 'seasonality', 'forecast demand',
    'locations', 'top locations', 'bottom locations',
  ];
  return omniTerms.some((t) => m.includes(t));
}

function stubChickfilaFindLocations(query) {
  return {
    message: 'Chick-fil-A locations tool is not yet connected. Use run_omni_analysis for data questions.',
    query,
    placeholder: true,
  };
}

function stubChickfilaOperatorMetrics(metricType) {
  return {
    message: 'Operator metrics tool is not yet connected. Use run_omni_analysis for metrics and KPIs.',
    metric_type: metricType,
    placeholder: true,
  };
}

function stubWeatherGetForecast(location, opts = {}) {
  return {
    source: 'Weather API (not connected yet)',
    location,
    hours: opts.hours || 12,
    placeholder: true,
    message: 'Weather tool is not connected yet.',
  };
}

function stubCalendarListEvents(args = {}) {
  return {
    source: 'Google Calendar API (not connected yet)',
    placeholder: true,
    message: 'Calendar tool is not connected yet.',
    args,
  };
}

function stubCalendarCreateEvent(args = {}) {
  return {
    source: 'Google Calendar API (not connected yet)',
    placeholder: true,
    message: 'Calendar tool is not connected yet.',
    args,
  };
}

module.exports = { createCoordinator, TOOL_DECLARATIONS };
