import os
import uuid
import requests
from langchain_core.tools import tool

SHOP_API = os.environ.get("SHOP_API_URL", "http://localhost:4000")


def _get(path):
    r = requests.get(f"{SHOP_API}{path}", timeout=10)
    return r.status_code, r.json()


def _post(path, body):
    r = requests.post(f"{SHOP_API}{path}", json=body, timeout=10)
    return r.status_code, r.json()


@tool
def search_catalog(query: str = "", category: str = "") -> dict:
    """Search the merchant's catalog. Optionally filter by a free-text query
    matched against name/description, and/or a category. Returns product id,
    name, price, stock, and whether this SKU is agent-purchasable. Always
    check `in_stock` and `policy.agent_purchasable` before proposing an item
    to the user."""
    status, data = _get("/catalog")
    if status != 200:
        return {"error": "catalog_unavailable", "detail": data}
    products = data.get("products", [])
    if query:
        q = query.lower()
        products = [p for p in products if q in p["name"].lower() or q in (p.get("description") or "").lower()]
    if category:
        products = [p for p in products if p.get("category", "").lower() == category.lower()]
    return {"products": products}


@tool
def get_product(product_id: str) -> dict:
    """Get full details for a single product by its exact catalog ID."""
    status, data = _get(f"/catalog/{product_id}")
    if status != 200:
        return {"error": "not_found", "product_id": product_id}
    return data


@tool
def place_order(session_id: str, items: list[dict]) -> dict:
    """Attempt to place an order. `items` is a list of
    {"product_id": str, "qty": int}. The backend runs guardrail checks
    (budget, category, agent-purchasability, stock, valid product IDs)
    BEFORE touching Razorpay. Possible outcomes:
    - status 'created': order + real Razorpay order created, ready for complete_payment.
    - status 'needs_confirmation': exceeds the session's confirmation
      threshold. You MUST tell the user the exact amount and reason and get
      their explicit yes/no before calling confirm_order. Never confirm on your own.
    - error 'policy_check_failed': a guardrail blocked the order. Explain the
      reason in plain language and use the `suggestion` field if present.
    A stable idempotency key is generated automatically per call."""
    idempotency_key = f"order-{uuid.uuid4()}"
    status, data = _post("/orders", {"session_id": session_id, "items": items, "idempotency_key": idempotency_key})
    return {"http_status": status, **data}


@tool
def confirm_order(order_id: str) -> dict:
    """Confirm an order that is in 'needs_confirmation' status. ONLY call
    this after the human user has explicitly said yes to the amount you told
    them. Never call this preemptively or without an explicit yes."""
    status, data = _post(f"/orders/{order_id}/confirm", {})
    return {"http_status": status, **data}


@tool
def complete_payment(order_id: str, outcome: str = "success") -> dict:
    """Complete payment for an order in 'created' status (test mode).
    outcome must be one of: 'success', 'insufficient_balance', 'declined'.
    Default to 'success' unless asked to simulate a failure. If payment
    fails, explain why and offer a concrete next step - never just report
    an error and stop."""
    status, data = _post(f"/payments/{order_id}/simulate", {"outcome": outcome})
    return {"http_status": status, **data}


@tool
def get_order_status(order_id: str) -> dict:
    """Look up the current status of an order."""
    status, data = _get(f"/orders/{order_id}")
    if status != 200:
        return {"error": "not_found", "order_id": order_id}
    return data


ALL_TOOLS = [search_catalog, get_product, place_order, confirm_order, complete_payment, get_order_status]