import os
import sys
import json
import requests
from dotenv import load_dotenv

load_dotenv()

SHOP_API = os.environ.get("SHOP_API_URL", "http://localhost:4000")


def create_session(budget_rupees, confirmation_threshold_rupees, actor_name="demo-buyer-agent"):
    body = {
        "actor_type": "agent",
        "actor_name": actor_name,
        "budget_limit": int(budget_rupees * 100),
        "confirmation_threshold": int(confirmation_threshold_rupees * 100),
    }
    r = requests.post(f"{SHOP_API}/sessions", json=body, timeout=10)
    r.raise_for_status()
    return r.json()


def extract_text(content):
    """Some providers return content as a list of blocks (text + metadata)
    instead of a plain string. Pull out just the human-readable text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts) if parts else str(content)
    return str(content)


def print_trace(messages, start_idx):
    """Print any new tool calls / tool results since start_idx, so you can
    see the agent's reasoning trail live, not just its final answer."""
    for msg in messages[start_idx:]:
        msg_type = msg.__class__.__name__
        if msg_type == "AIMessage" and getattr(msg, "tool_calls", None):
            for tc in msg.tool_calls:
                print(f"  → tool call: {tc['name']}({json.dumps(tc['args'])})")
        elif msg_type == "ToolMessage":
            content = msg.content if isinstance(msg.content, str) else json.dumps(msg.content)
            trimmed = content if len(content) < 300 else content[:300] + "...[truncated]"
            print(f"  ← tool result: {trimmed}")


def main():
    if "GROQ_API_KEY" not in os.environ:
        print("Set GROQ_API_KEY in .env (get a free key at https://console.groq.com)")
        sys.exit(1)

    from agent import build_agent
    from growth_agent import build_growth_agent
    from supervisor import classify_intent
    from utils import safe_reply_text

    print("=== AI Buyer Agent Demo ===")
    budget = float(os.environ.get("DEMO_BUDGET_RUPEES", "2000"))
    threshold = float(os.environ.get("DEMO_CONFIRM_THRESHOLD_RUPEES", "1500"))
    session = create_session(budget, threshold)
    session_id = session["id"]
    print(f"Session created: {session_id}")
    print(f"Budget: ₹{budget:.2f} | Confirmation required above: ₹{threshold:.2f}")
    print(f"Audit trail: GET {SHOP_API}/audit-log?session_id={session_id}")
    print("Type 'quit' to exit.\n")

    shopping_agent = build_agent()
    growth_agent = build_growth_agent()
    messages = [{"role": "user", "content": f"[SYSTEM CONTEXT] Your session_id for all orders is: {session_id}"}]

    while True:
        try:
            user_input = input("You: ")
        except (EOFError, KeyboardInterrupt):
            print("\nbye.")
            break
        if user_input.strip().lower() in ("quit", "exit"):
            break
        if not user_input.strip():
            continue


        messages.append({"role": "user", "content": user_input})
        start_idx = len(messages)

        route = classify_intent(messages)
        active_agent = growth_agent if route == "growth" else shopping_agent
        print(f"  [routed to: {route}]")

        result = active_agent.invoke({"messages": messages})
        messages = result["messages"]

        print_trace(messages, start_idx)
        final = messages[-1]
        # print(f"[DEBUG raw content]: {repr(final.content)}\n")
        # print(f"Agent: {extract_text(final.content)}\n")
        # text = extract_text(final.content)
        # if not text.strip():
        #     text = "(No response text was returned for that turn - the action may have completed. Try asking for a status update.)"
        # print(f"Agent: {text}\n")
        print(f"Agent: {safe_reply_text(final.content)}\n")



if __name__ == "__main__":
    main()