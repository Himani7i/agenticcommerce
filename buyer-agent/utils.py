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


def safe_reply_text(content):
    """extract_text, but never returns a blank string """
    text = extract_text(content).strip()
    return text if text else "(No response text was returned for that turn - the action may have completed. Try asking for a status update.)"