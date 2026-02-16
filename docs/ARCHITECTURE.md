# Pulse: Gemini as Coordination Layer

## Overview

The Ask Gleam chat can call **multiple tools** (Omni API, Chick-fil-A MCPs/APIs). **Gemini** is the coordination layer: it interprets the user’s message, decides which tool(s) to call, and returns a single, user-friendly reply.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────────────┐
│  Pulse Frontend │────▶│  Our Backend     │────▶│  Gemini (Coordinator)       │
│  (Ask Gleam)    │     │  POST /api/chat  │     │  - Understands intent       │
└─────────────────┘     └──────────────────┘     │  - Chooses tool(s)          │
        ▲                         │              │  - Can call multiple tools   │
        │                         │              └──────────────┬──────────────┘
        │                         │                             │
        │                         │              ┌──────────────▼──────────────┐
        │                         │              │  Tool execution (our code)   │
        │                         │              │  - run_omni_analysis        │
        │                         │              │  - chickfila_* (MCP/APIs)   │
        │                         │              └──────────────┬──────────────┘
        │                         │                             │
        │                         │              ┌──────────────▼──────────────┐
        │                         │              │  External systems           │
        │                         │              │  - Omni Agentic API         │
        │                         │              │  - Chick-fil-A MCP servers  │
        │                         │              │  - Other REST APIs           │
        │                         │              └─────────────────────────────┘
        │                         │
        │                         ▼
        │              ┌──────────────────┐
        └──────────────│  Final text       │
                       │  (one response)   │
                       └──────────────────┘
```

## Flow

1. **User** types in Ask Gleam → frontend sends `POST /api/chat` with `{ message }`.
2. **Backend** forwards the message (and optional conversation history) to **Gemini** with a list of **tool declarations** (names, descriptions, parameters).
3. **Gemini** either:
   - **Responds with text** → backend returns that as the chat reply, or
   - **Responds with one or more function calls** (e.g. `run_omni_analysis`, `chickfila_find_locations`) → backend runs those tools and sends the results back to Gemini.
4. **Backend** repeats step 3 until Gemini returns a **text-only** answer (no more tool calls).
5. **Backend** returns that final text to the frontend; the frontend shows it in the chat (with markdown rendering).

Tool execution is **our responsibility**: we map each function name to real calls (Omni Agentic API, MCPs, REST, etc.) and return structured results to Gemini so it can summarize for the operator.

## Tools (current and extensible)

| Tool name               | Purpose                         | Backing implementation        |
|-------------------------|---------------------------------|--------------------------------|
| `run_omni_analysis`     | Run natural-language analysis  | Omni Agentic API (submit → poll → result) |
| `chickfila_find_locations` | Find Chick-fil-A locations   | Placeholder / future MCP or API |
| `chickfila_operator_metrics` | Get operator metrics       | Placeholder / future MCP or API |

New tools (e.g. more Chick-fil-A actions or other MCPs) are added by:

1. Defining a new **function declaration** for Gemini (name, description, parameters).
2. Implementing the **handler** in the backend (call Omni, MCP, or REST).
3. Registering the handler in the coordinator’s tool map.

## Why Gemini in the middle?

- **Single entry point**: One chat API; Gemini decides when to use Omni vs Chick-fil-A vs neither.
- **Natural language**: Users ask in plain language; Gemini turns that into the right tool calls and parameters.
- **Composition**: Gemini can call Omni for analysis and a Chick-fil-A tool for actions in one conversation turn (or across turns).
- **Consistent UX**: The user always sees one reply per turn, even when multiple tools were used.

## Configuration

- **Gemini**: `GEMINI_API_KEY` in `.env` (from Google AI Studio).
- **Omni**: Existing `OMNI_*` env vars; used when executing `run_omni_analysis`.
- **Chick-fil-A / MCPs**: To be wired via env or config (e.g. MCP server URLs, API keys) when you add real implementations.

## Endpoints

- **`POST /api/chat`**  
  Body: `{ message: string, conversationId?: string }`  
  Uses Gemini + tools; returns `{ reply: string }` (and optionally `conversationId` for future multi-turn).

- **`POST /api/agentic/jobs`** (and poll/result/cancel)  
  Still available for **direct** Omni-only use (e.g. other clients or debugging). The main Ask Gleam flow goes through `/api/chat` and Gemini.
