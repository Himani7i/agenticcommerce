from rag import build_index, semantic_search_raw

count = build_index()
print(f"Indexed {count} products.\n")

queries = [
    "something warm for a cold winter trip",
    "footwear for exercise",
    "an accessory for sunny days",
]

for q in queries:
    print(f"Query: {q!r}")
    results = semantic_search_raw(q, n_results=2)
    ids = results["ids"][0]
    docs = results["documents"][0]
    for pid, doc in zip(ids, docs):
        print(f"  -> {pid}: {doc}")
    print()