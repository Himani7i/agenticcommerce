import os
import requests
import chromadb

SHOP_API = os.environ.get("SHOP_API_URL", "http://localhost:4000")

# In-memory client - we rebuild this small index fresh every time the agent
# starts, rather than persisting it to disk. At 6 products this is instant,
# and it completely sidesteps any "is the index stale vs the real catalog"
# problem, since it's always built from the live /catalog response.
_client = chromadb.Client()
_collection = None


def build_index():
    global _collection
    r = requests.get(f"{SHOP_API}/catalog", timeout=10)
    products = r.json().get("products", [])

    try:
        _client.delete_collection("catalog")
    except Exception:
        pass
    _collection = _client.create_collection("catalog")  # uses Chroma's built-in ONNX embedding model

    if not products:
        return

    _collection.add(
        ids=[p["id"] for p in products],
        documents=[f"{p['name']}. {p['description']}. Category: {p['category']}." for p in products],
        metadatas=[{"product_id": p["id"]} for p in products]
    )
    return len(products)


def semantic_search_raw(query: str, n_results: int = 3):
    if _collection is None:
        build_index()
    return _collection.query(query_texts=[query], n_results=n_results)