import os
import time
import json
import hmac
import hashlib
import requests
from dotenv import load_dotenv

load_dotenv()

SHOP_API = os.environ.get("SHOP_API_URL", "http://localhost:4000")
WEBHOOK_SECRET = os.getenv('RAZORPAY_WEBHOOK_SECRET')

results = []  # (name, passed, detail)


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))


def create_session(**kwargs):
    r = requests.post(f"{SHOP_API}/sessions", json=kwargs, timeout=10)
    r.raise_for_status()
    return r.json()


def place_order(session_id, items, **kwargs):
    body = {"session_id": session_id, "items": items, **kwargs}
    r = requests.post(f"{SHOP_API}/orders", json=body, timeout=10)
    try:
        return r.status_code, r.json()
    except ValueError:
        return r.status_code, {}


def send_webhook(razorpay_order_id, amount, bad_signature=False):
    payload = {
        "event": "payment.captured",
        "payload": {"payment": {"entity": {
            "id": f"pay_eval_{int(time.time() * 1000)}",
            "order_id": razorpay_order_id,
            "amount": amount,
            "status": "captured",
        }}},
    }
    body = json.dumps(payload)
    secret = "deliberately_wrong_secret" if bad_signature else WEBHOOK_SECRET
    sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    r = requests.post(
        f"{SHOP_API}/webhooks/razorpay",
        data=body,
        headers={"Content-Type": "application/json", "x-razorpay-signature": sig},
        timeout=10,
    )
    return r.status_code, r.json()


# ---- Guardrail evals ----

def eval_budget_cap():
    s = create_session(actor_type="agent", actor_name="eval-budget", budget_limit=50000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "SHOES001", "qty": 1}])  # 349900 > 50000
    check("budget_cap blocks over-budget order",
          status == 422 and data.get("failed_check", {}).get("name") == "budget_cap", data)


def eval_purchasability_block():
    s = create_session(actor_type="agent", actor_name="eval-purchasable", budget_limit=2000000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "JACKET001", "qty": 1}])
    check("sku_agent_purchasable blocks human-only SKU",
          status == 422 and data.get("failed_check", {}).get("name") == "sku_agent_purchasable", data)


def eval_stock_block():
    s = create_session(actor_type="agent", actor_name="eval-stock", budget_limit=2000000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "CAP001", "qty": 1}])
    check("stock_available blocks out-of-stock item",
          status == 422 and data.get("failed_check", {}).get("name") == "stock_available", data)


def eval_hallucinated_product():
    s = create_session(actor_type="agent", actor_name="eval-hallucinate", budget_limit=2000000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "NOT_A_REAL_PRODUCT", "qty": 1}])
    check("valid_product_ids blocks hallucinated SKU",
          status == 422 and data.get("failed_check", {}).get("name") == "valid_product_ids", data)


def eval_discount_within_limit():
    s = create_session(actor_type="agent", actor_name="eval-discount-ok", budget_limit=2000000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "TSHIRT001", "qty": 1}], discount_pct=10, discount_reason="eval test")
    expected_amount = round(79900 * 0.9)
    check("valid discount applies correct server-computed amount",
          status == 201 and data.get("amount") == expected_amount, data)


def eval_discount_over_limit():
    s = create_session(actor_type="agent", actor_name="eval-discount-over", budget_limit=2000000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "TSHIRT001", "qty": 1}], discount_pct=50, discount_reason="eval test")
    check("discount_within_limit blocks excessive discount",
          status == 422 and data.get("failed_check", {}).get("name") == "discount_within_limit", data)


def eval_discount_missing_reason():
    s = create_session(actor_type="agent", actor_name="eval-discount-noreason", budget_limit=2000000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "TSHIRT001", "qty": 1}], discount_pct=10)
    check("discount without reason rejected before guardrails run", status == 400, data)


def eval_confirmation_gate():
    s = create_session(actor_type="agent", actor_name="eval-confirm", budget_limit=500000, confirmation_threshold=150000)
    status, data = place_order(s["id"], [{"product_id": "SHOES001", "qty": 1}])  # 349900: under budget, over threshold
    held = status == 202 and data.get("status") == "needs_confirmation" and "razorpay_order_id" not in data
    order_id = data.get("id")
    r2 = requests.post(f"{SHOP_API}/orders/{order_id}/confirm", timeout=10)
    released = r2.status_code == 201 and r2.json().get("razorpay_order_id") is not None
    check("confirmation gate holds, then releases only on explicit confirm",
          held and released, {"held": held, "released": released})


def eval_idempotency():
    s = create_session(actor_type="agent", actor_name="eval-idem", budget_limit=500000, confirmation_threshold=1000000)
    key = f"eval-idem-{time.time()}"
    status1, data1 = place_order(s["id"], [{"product_id": "SOCKS001", "qty": 1}], idempotency_key=key)
    status2, data2 = place_order(s["id"], [{"product_id": "SOCKS001", "qty": 1}], idempotency_key=key)
    check("idempotent replay returns same order, not a duplicate",
          data1.get("id") == data2.get("id") and data2.get("idempotent_replay") is True,
          {"first": data1.get("id"), "second": data2.get("id")})


# ---- Webhook security evals ----

def eval_webhook_valid_and_duplicate():
    s = create_session(actor_type="agent", actor_name="eval-webhook", budget_limit=500000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "TSHIRT001", "qty": 1}])
    rzp_order_id = data.get("razorpay_order_id")
    if not rzp_order_id:
        check("webhook valid signature processes payment", False, "no razorpay_order_id - check RAZORPAY keys in .env")
        check("duplicate webhook is idempotent", False, "skipped - depends on prior step")
        return
    s1, d1 = send_webhook(rzp_order_id, data["amount"])
    check("webhook valid signature processes payment", s1 == 200 and d1.get("status") == "processed", d1)
    s2, d2 = send_webhook(rzp_order_id, data["amount"])
    check("duplicate webhook delivery is idempotent", s2 == 200 and d2.get("status") == "already_processed", d2)


def eval_webhook_bad_signature():
    s = create_session(actor_type="agent", actor_name="eval-webhook-bad", budget_limit=500000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "TSHIRT001", "qty": 1}])
    rzp_order_id = data.get("razorpay_order_id")
    if not rzp_order_id:
        check("webhook bad signature rejected", False, "no razorpay_order_id")
        return
    s1, d1 = send_webhook(rzp_order_id, data["amount"], bad_signature=True)
    check("webhook with invalid signature is rejected",
          s1 == 400 and d1.get("error") == "invalid_signature", d1)


def eval_webhook_amount_mismatch():
    s = create_session(actor_type="agent", actor_name="eval-webhook-mismatch", budget_limit=500000, confirmation_threshold=1000000)
    status, data = place_order(s["id"], [{"product_id": "SOCKS001", "qty": 1}])
    rzp_order_id = data.get("razorpay_order_id")
    if not rzp_order_id:
        check("webhook amount mismatch flagged, never paid", False, "no razorpay_order_id")
        return
    s1, d1 = send_webhook(rzp_order_id, 500)  # deliberately wrong amount
    order_after = requests.get(f"{SHOP_API}/orders/{data['id']}", timeout=10).json()
    check("webhook amount mismatch flagged, never silently paid",
          s1 == 200 and d1.get("status") == "flagged" and order_after.get("status") == "flagged_for_review",
          {"webhook_response": d1, "order_status": order_after.get("status")})


# ---- RAG + Supervisor evals ----

def eval_rag_semantic_match():
    from rag import build_index, semantic_search_raw
    build_index()
    result = semantic_search_raw("something warm for a cold winter trip", n_results=1)
    top_id = result["ids"][0][0] if result["ids"] and result["ids"][0] else None
    check("semantic search matches jacket for a non-keyword-overlapping query", top_id == "JACKET001", top_id)


def eval_supervisor_routing():
    from supervisor import classify_intent
    cases = [
        ([{"role": "user", "content": "I want to buy a cotton t-shirt"}], "shopping"),
        ([{"role": "user", "content": "What goes well with running shoes?"}], "growth"),
        ([{"role": "user", "content": "Can I get a discount if I buy two items?"}], "growth"),
    ]
    all_correct = True
    detail = []
    for msgs, expected in cases:
        result = classify_intent(msgs)
        detail.append({"input": msgs[-1]["content"], "expected": expected, "got": result})
        if result != expected:
            all_correct = False
    check("supervisor routes intent to the correct specialist", all_correct, detail)


def run_all():
    print("Running eval suite against live shop-backend + buyer-agent...\n")
    for fn in [
        eval_budget_cap, eval_purchasability_block, eval_stock_block, eval_hallucinated_product,
        eval_discount_within_limit, eval_discount_over_limit, eval_discount_missing_reason,
        eval_confirmation_gate, eval_idempotency,
        eval_webhook_valid_and_duplicate, eval_webhook_bad_signature, eval_webhook_amount_mismatch,
        eval_rag_semantic_match, eval_supervisor_routing,
    ]:
        fn()

    print(f"{'CHECK':<58} RESULT")
    print("-" * 70)
    for name, ok, detail in results:
        print(f"{name:<58} {'PASS' if ok else 'FAIL'}")
        if not ok:
            print(f"   -> {detail}")
    print("-" * 70)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{passed}/{total} passed\n")
    return passed == total


if __name__ == "__main__":
    import sys
    sys.exit(0 if run_all() else 1)