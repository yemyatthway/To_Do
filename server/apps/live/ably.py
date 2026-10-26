"""Live updates through Ably (https://ably.com), over its plain REST API.

Our server stays the source of truth: it saves things first, then publishes a small event so open
apps update at once. Channels:

    user:<id>      events for one person (new chat message, tasks changed, friend request...)
    online:<id>    nothing but that person's presence, which their friends can see
    chat:<id>      one conversation: new / deleted messages, "typing", "seen"
    admin          staff only: new sign-ups and logins

Each browser gets a short-lived pass (a signed "token request") that only allows its own channels.
Without ABLY_API_KEY everything here is a no-op and the app falls back to refreshing.
"""

import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
from urllib.parse import quote

import requests
from django.conf import settings
from django.db import close_old_connections

logger = logging.getLogger(__name__)

REST = "https://rest.ably.io"
TOKEN_TTL_MS = 60 * 60 * 1000  # the app renews it by itself


def enabled():
    return bool(settings.ABLY_API_KEY)


def _key():
    name, _, secret = settings.ABLY_API_KEY.partition(":")
    return name, secret


def token_request(client_id, capability):
    """A signed request the browser trades with Ably for a token limited to `capability`
    ({channel: [operations]}). The key's secret never leaves the server."""
    key_name, secret = _key()
    fields = {
        "keyName": key_name,
        "ttl": TOKEN_TTL_MS,
        "capability": json.dumps(capability, separators=(",", ":"), sort_keys=True),
        "clientId": str(client_id),
        "timestamp": int(time.time() * 1000),
        "nonce": secrets.token_hex(16),
    }
    signed = "".join(f"{fields[k]}\n" for k in ("keyName", "ttl", "capability", "clientId", "timestamp", "nonce"))
    fields["mac"] = base64.b64encode(hmac.new(secret.encode(), signed.encode(), hashlib.sha256).digest()).decode()
    return fields


def _post(channel, name, data):
    try:
        response = requests.post(
            f"{REST}/channels/{quote(channel, safe='')}/messages",
            json={"name": name, "data": data},
            auth=_key(),
            timeout=5,
        )
        if response.status_code >= 300:
            logger.warning("Ably publish to %s failed: %s %s", channel, response.status_code, response.text[:200])
    except requests.RequestException as exc:
        logger.warning("Ably publish to %s failed: %s", channel, exc)


def _send(batch):
    for channel, name, data in batch:
        _post(channel, name, data)


def _send_in_background(batch):
    try:
        _send(batch)
    finally:
        close_old_connections()  # only the worker thread gives back its DB connection


def publish(batch):
    """batch: [(channel, event name, data)]. Sent in the background so nobody waits on it."""
    if not enabled() or not batch:
        return
    if settings.LIVE_SEND_ASYNC:
        threading.Thread(target=_send_in_background, args=(list(batch),), daemon=True).start()
    else:
        _send(batch)


def present(channel):
    """Client ids currently present on a channel (e.g. who has a chat open). Empty if unknown."""
    if not enabled():
        return set()
    try:
        response = requests.get(f"{REST}/channels/{quote(channel, safe='')}/presence", auth=_key(), timeout=3)
        response.raise_for_status()
        return {str(member.get("clientId")) for member in response.json()}
    except (requests.RequestException, ValueError):
        return set()


# --- small helpers used around the app -----------------------------------------------------

def to_users(user_ids, name, data=None):
    publish([(f"user:{uid}", name, data or {}) for uid in dict.fromkeys(user_ids) if uid])


def to_chat(conversation_id, name, data=None):
    publish([(f"chat:{conversation_id}", name, data or {})])


def to_admins(name, data=None):
    publish([("admin", name, data or {})])
