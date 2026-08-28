import os
import uuid
import requests
from langchain_core.tools import tool
from rag import semantic_search_raw
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
def place_order(session_id: str, items: list[dict], discount_pct: float = 0, discount_reason: str = "") -> dict:
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

    If proposing a discount (growth agent only): pass discount_pct (0-100)
    AND a specific discount_reason describing why (e.g. "bundled with
    running shoes purchase"). The backend REQUIRES a reason whenever
    discount_pct > 0, and will reject the discount if it exceeds the
    merchant's configured limit - explain that limit to the user if so.
    A stable idempotency key is generated automatically per call."""
    idempotency_key = f"order-{uuid.uuid4()}"
    body = {"session_id": session_id, "items": items, "idempotency_key": idempotency_key}
    if discount_pct > 0:
        body["discount_pct"] = discount_pct
        body["discount_reason"] = discount_reason
    status, data = _post("/orders", body)
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

@tool
def semantic_search(query: str) -> dict:
    """Search the catalog by MEANING rather than exact keywords. Use this
    when the user describes what they want in natural language (e.g.
    'something warm for a winter trip', 'an accessory for sunny days')
    rather than naming an exact product. Falls back well when search_catalog
    (keyword match) returns nothing useful."""
    raw = semantic_search_raw(query, n_results=3)
    ids = raw.get("ids", [[]])[0]
    if not ids:
        return {"products": []}
    products = []
    for pid in ids:
        status, data = _get(f"/catalog/{pid}")
        if status == 200:
            products.append(data)
    return {"products": products}

@tool
def suggest_crosssell(product_id: str) -> dict:
    """Given a product the user is already buying or considering, returns
    complementary products the merchant suggests pairing with it. Use this
    to propose a relevant add-on - never invent a pairing yourself."""
    status, data = _get(f"/catalog/{product_id}/crosssell")
    if status != 200:
        return {"suggestions": []}
    return data

SHOPPING_TOOLS = [search_catalog, semantic_search, get_product, place_order, confirm_order, complete_payment, get_order_status]
GROWTH_TOOLS = SHOPPING_TOOLS + [suggest_crosssell]

ALL_TOOLS = GROWTH_TOOLS 