# Agentic Commerce — AI Buyer & Growth Agent on Razorpay

An AI agent that shops a merchant's Razorpay test-mode store end-to-end on a human's behalf, and a second specialist agent that grows revenue through cross-sell and discounts — both operating under server-enforced guardrails, gated for human confirmation above a threshold, and logged to a plain-English audit trail that's independently verifiable, not just narrated by the agent.

**Track:** AI Growth & Agentic Commerce

---

## The problem this solves

Two things the brief asks for, usually treated as separate projects:
1. **Grow a merchant's revenue** through smarter, AI-driven upselling.
2. **Make a merchant transactable by an AI buyer** — the emerging "agent-to-agent commerce" problem NPCI's UAP, Google's ACP, and OpenAI's AP2 are all racing to standardize.

This project treats them as one system: a merchant backend that's agent-readable by *any* AI buyer (ours or someone else's), fronted by our own multi-agent system that demonstrates both directions live.

---

## The one rule everything else follows

> **The Node.js backend is the only thing that ever touches money, the database, or Razorpay. The Python AI agent never does either directly.**

The agent can only *propose* actions by calling the backend's HTTP API. The backend independently re-checks every proposal against server-side rules before anything financial happens — an LLM hallucinating a price, a product, or a discount cannot cause a bad charge, because the backend recomputes everything from its own catalog and never trusts a client-supplied number. This is the same principle real agent-payment protocols (AP2, ACP, UAP) are built on: delegated, *limited* authority — never raw access.

---

## Architecture

```
   Human (via chat UI)          External AI buyer (any agent, e.g. ChatGPT)
        │                                    │
        ▼                                    │
┌─────────────────────────────┐              │
│   Agent layer (Python)       │              │
│   LangGraph + Groq/Qwen3.6   │              │
│                              │              │
│   Supervisor (classify+route)│              │
│     ├─ Shopping agent        │              │
│     │   (search, RAG, buy)   │              │
│     └─ Growth agent          │              │
│         (cross-sell, discount)              │
└──────────────┬───────────────┘              │
               │  HTTP                        │  HTTP (direct)
               ▼                              ▼
┌──────────────────────────────────────────────────┐
│         Node.js gateway (Express)                 │
│         The ONLY thing that touches money          │
│                                                     │
│   Catalog · Sessions (Mandates) · Orders           │
│   Guardrails · Audit log · Webhook listener        │
└──────────────────────┬─────────────────────────────┘
                        │  Razorpay SDK + signed webhooks
                        ▼
              Razorpay (test mode)
```

An external AI buyer that isn't ours doesn't need to go through our agent at all — the catalog and order endpoints are agent-readable on their own. Our LangGraph agent is *one* client of the gateway, not a required gatekeeper.

---

## How this maps to the "bar to pass"

| Requirement | How it's met |
|---|---|
| **Explainable** | Every money-relevant decision writes a plain-English `explanation` to the audit log. |
| **Bounded** | Server-side guardrails: budget cap, category allow-list, per-SKU agent-purchasability, per-SKU price cap, stock check, hallucinated-product-ID check, discount percentage cap — all enforced in Node. |
| **Gated** | Orders above a configurable confirmation threshold are held (`needs_confirmation`) and never reach Razorpay until a human explicitly confirms. The agent is instructed never to self-confirm. |
| **Audit trail** | Queryable per-session via `GET /audit-log`, and rendered live in the UI, polling the backend directly (not through the agent, so it can't be shaped by agent narration). |
| **Graceful failure** | Every guardrail block returns a `suggestion` alongside the reason (try a cheaper item, choose an in-stock alternative, etc.). |

---

## What's actually built

**Backend (`shop-backend`, Node/Express):**
- Agent-readable catalog with explicit per-SKU policy (`agent_purchasable`, `max_agent_price`)
- Sessions acting as AP2-style "Intent Mandates" (budget, category allow-list, confirmation threshold — set *before* the agent acts, not something it can raise itself)
- Full guardrail-checked order pipeline, including a discount feature with its own server-enforced cap
- Real Razorpay test-mode order creation
- A genuine webhook listener: raw-body HMAC-SHA256 signature verification, idempotent-by-payment-ID delivery handling, and a hard check that the captured amount matches the order — flags for review rather than trusting a mismatched claim
- `node:sqlite` (Node's built-in database) — zero native dependencies, zero build tools required

**Agent layer (`buyer-agent`, Python/LangGraph, RAG(Chroma)):**
- A Supervisor that classifies each turn and routes to the correct specialist
- **Shopping agent**: catalog search, RAG-backed semantic search (Chroma, local ONNX embeddings), order placement, payment
- **Growth agent**: merchant-configured cross-sell suggestions, discount application (bounded by the same server-side cap)
- Groq-hosted `qwen/qwen3.6-27b` 
- An automated eval suite: 15 guardrail/security/RAG/routing checks, run via direct HTTP calls (bypassing the LLM itself, since eval determinism matters more than conversational realism for a test suite) — **15/15 passing**

**Frontend (`buyer-agent/static`):**
- React (loaded via CDN + Babel standalone)
- Chat UI with an expandable reasoning trace per turn (real tool calls/results)
- A live audit-trail panel, polling the backend directly and independently of the chat

---

## Setup

### 1. Backend
```
cd shop-backend
cp .env.example .env      # fill in RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
npm install
npm start                 # -> http://localhost:4000
```

### 2. Agent + API + frontend
```
cd buyer-agent
cp .env.example .env      # fill in GROQ_API_KEY (free, console.groq.com)
python -m venv venv
.\venv\Scripts\Activate.ps1        # Windows PowerShell
pip install -r requirements.txt
pip install chromadb fastapi "uvicorn[standard]"
python -m uvicorn api:app --reload --port 8000
```

Open **http://localhost:8000/**.

### 3. Verify everything (optional but recommended)
```
python eval_suite.py
```
Expect `15/15 passed`.

---

## Repo structure
```
shop-backend/     Node/Express - the only component that touches money, the DB, or Razorpay
  src/
    db.js               node:sqlite schema + queries
    policy.js           guardrail checks (pure logic, no DB import)
    audit.js            audit log read/write
    razorpay.js         all Razorpay SDK calls, isolated
    config.js           merchant config (discount cap, cross-sell map)
    routes/             catalog, sessions, orders, payments, webhooks, audit, crosssell
  test-webhook.js       standalone signed-webhook test tool
  update-descriptions.js  one-off catalog enrichment script

buyer-agent/      Python - the AI layer, talks to shop-backend over HTTP only
  tools.py              LangGraph tool wrappers, 1:1 with backend endpoints
  agent.py              Shopping agent
  growth_agent.py       Growth agent
  supervisor.py         Intent classifier / router
  rag.py                Chroma-backed semantic catalog search
  api.py                FastAPI server (stateful chat, wraps both agents)
  main.py               CLI chat loop (used throughout development/testing)
  eval_suite.py         Automated guardrail/security/RAG/routing checks
  static/index.html     React (CDN) chat UI + live audit panel

TESTING_LOG.md     Every test performed, chronologically, with commands and results
```
---

## Known limitations

- **Payment capture for an AI buyer is simulated in test mode.** Non-interactive payment capture (no human clicking Checkout, no PIN/OTP) isn't something Razorpay or any PCI-compliant processor exposes today — this is the actual open problem AP2/ACP/UAP are standardizing.
- Every simulated event is labeled `[TEST-MODE SIMULATION]` in the audit log so it's never confused with a real capture. The real webhook listener (HMAC-verified, amount-checked) is fully implemented and tested for the human-checkout path.
- Data store is a local SQLite file.