from dotenv import load_dotenv
load_dotenv()
from supervisor import classify_intent

test_cases = [
    [{"role": "user", "content": "I want to buy a cotton t-shirt"}],
    [{"role": "user", "content": "What goes well with running shoes?"}],
    [{"role": "user", "content": "Can I get a discount if I buy two items?"}],
    [
        {"role": "user", "content": "I'm buying running shoes, what else would go well with them?"},
        {"role": "assistant", "content": "I recommend the Ankle Socks for ₹199. Want to add them with a discount?"},
        {"role": "user", "content": "yes"},
    ],
]

for msgs in test_cases:
    result = classify_intent(msgs)
    print(f"{result:10} <- {msgs[-1]['content']!r}")