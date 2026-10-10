"""Who is making a request (the Actor).

Maki sends "Authorization: Bearer <token>"; only the token's SHA-256 is stored,
in the per-machine config outside Drive. The browser UI gets a random cookie
when it loads the page. This gives attribution, not security: anything running
on this PC could read the database file directly (ADR 0002).
"""
import hashlib
import hmac
import secrets

UI_COOKIE = "eo_ui"
UI_KEY = secrets.token_urlsafe(24)      # new on every server start
BEST = "best"


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token():
    return secrets.token_urlsafe(32)


def _cookie(headers, name):
    for part in (headers.get("Cookie") or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return v
    return None


def actor(headers, agent_tokens):
    """Returns (actor, error). actor is None when the request carries no valid identity."""
    header = headers.get("Authorization") or ""
    if header:
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            return None, "Authorization must be 'Bearer <token>'"
        digest = hash_token(token.strip())
        for t in agent_tokens:
            if hmac.compare_digest(digest, str(t.get("sha256", ""))):
                return str(t.get("name") or "agent"), None
        return None, "unknown token"
    ui = _cookie(headers, UI_COOKIE)
    if ui and hmac.compare_digest(ui, UI_KEY):
        return BEST, None
    return None, None
