import os
from langchain_groq import ChatGroq

CLASSIFY_PROMPT = """You are a routing classifier for a shopping assistant system. Given the
conversation so far, decide which specialist should handle the NEXT reply:

- "shopping": the user wants to browse, search, or buy a specific item with
  no bundling/discount/upsell involved.
- "growth": the user is asking for recommendations, cross-sell/bundle
  suggestions, or a discount - OR the previous turn was already a growth
  proposal (e.g. a bundle or discount offer) and the user is now replying
  to it (e.g. "yes", "sure", confirming or declining that offer).

Respond with EXACTLY one word: shopping or growth. Nothing else."""


def classify_intent(messages: list) -> str:
    model = ChatGroq(
        model="qwen/qwen3.6-27b",
        temperature=0,
        groq_api_key=os.environ["GROQ_API_KEY"],
    )
    # Only a short window of recent context is needed to disambiguate a
    # short reply like "yes" - it doesn't need the whole conversation.
    recent = messages[-6:]
    response = model.invoke([{"role": "system", "content": CLASSIFY_PROMPT}, *recent])
    text = response.content if isinstance(response.content, str) else str(response.content)
    text = text.strip().lower()
    return "growth" if "growth" in text else "shopping"  # default to the narrower-tools specialist when unsure