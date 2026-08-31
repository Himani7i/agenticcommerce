import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pathlib import Path
from pydantic import BaseModel
import requests
from dotenv import load_dotenv

load_dotenv()

from agent import build_agent
from growth_agent import build_growth_agent
from supervisor import classify_intent
from utils import safe_reply_text

SHOP_API = os.environ.get("SHOP_API_URL", "http://localhost:4000")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # fine for a local hackathon demo; would be locked down in production
    allow_methods=["*"],
    allow_headers=["*"],
)

# Built once at startup, reused across all conversations - the LLM clients
# themselves are stateless; per-conversation state lives in `conversations` below.
shopping_agent = build_agent()
growth_agent = build_growth_agent()

# In-memory store: conversation_id -> {"messages": [...], "session_id": "..."}
# Fine for a demo/single-process server. Would need a real store (Redis, DB)
# for anything that needs to survive a server restart or run multiple processes.
conversations = {}


class ChatRequest(BaseModel):
    conversation_id: str
    message: str


class NewConversationRequest(BaseModel):
    budget_rupees: float = 2000
    confirmation_threshold_rupees: float = 1500


@app.post("/conversations")
def new_conversation(req: NewConversationRequest):
    """Creates a new backend session (budget/guardrails) AND a fresh
    conversation. Returns both IDs - the frontend only needs to remember
    conversation_id; session_id is kept server-side."""
    body = {
        "actor_type": "agent",
        "actor_name": "web-buyer-agent",
        "budget_limit": int(req.budget_rupees * 100),
        "confirmation_threshold": int(req.confirmation_threshold_rupees * 100),
    }
    r = requests.post(f"{SHOP_API}/sessions", json=body, timeout=10)
    r.raise_for_status()
    session = r.json()

    conversation_id = session["id"]  # reuse the backend session id as the conversation id - simple, unique, one less ID to track
    conversations[conversation_id] = {
        "messages": [{"role": "user", "content": f"[SYSTEM CONTEXT] Your session_id for all orders is: {session['id']}"}],
        "session_id": session["id"],
    }

    return {
        "conversation_id": conversation_id,
        "session_id": session["id"],
        "budget_rupees": req.budget_rupees,
        "confirmation_threshold_rupees": req.confirmation_threshold_rupees,
    }


@app.post("/chat")
def chat(req: ChatRequest):
    """Sends one message into an existing conversation, routes it to the
    correct specialist, and returns the reply plus a trace of what
    happened - the trace is what the frontend will render as the
    'agent reasoning' panel."""
    convo = conversations.get(req.conversation_id)
    if not convo:
        return {"error": "conversation_not_found"}

    messages = convo["messages"]
    messages.append({"role": "user", "content": req.message})
    start_idx = len(messages)

    route = classify_intent(messages)
    active_agent = growth_agent if route == "growth" else shopping_agent

    result = active_agent.invoke({"messages": messages})
    messages = result["messages"]
    convo["messages"] = messages

    trace = []
    for msg in messages[start_idx:]:
        msg_type = msg.__class__.__name__
        if msg_type == "AIMessage" and getattr(msg, "tool_calls", None):
            for tc in msg.tool_calls:
                trace.append({"type": "tool_call", "name": tc["name"], "args": tc["args"]})
        elif msg_type == "ToolMessage":
            trace.append({"type": "tool_result", "content": msg.content})

    final = messages[-1]
    return {
        "route": route,
        "reply": safe_reply_text(final.content),
        "trace": trace,
        "session_id": convo["session_id"],
    }

@app.get("/", response_class=HTMLResponse)
def serve_frontend():
    return Path(__file__).parent.joinpath("static", "index.html").read_text(encoding="utf-8")

@app.get("/health")
def health():
    return {"status": "ok"}