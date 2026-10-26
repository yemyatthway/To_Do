"""Chat messages are encrypted before they reach the database (Fernet: AES + HMAC).

The key lives only in the server's environment (CHAT_ENCRYPTION_KEYS), never in the database, so a
database copy or someone browsing it sees scrambled text. This is encryption at rest, not
end-to-end: the server itself can decrypt, which is how it shows messages to the two people in a
chat. Several keys can be listed (newest first) to rotate without losing old messages.

Make a key with:  uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


@lru_cache(maxsize=1)
def _fernet():
    keys = [k.strip() for k in settings.CHAT_ENCRYPTION_KEYS if k.strip()]
    if not keys:
        if not settings.CHAT_ALLOW_DERIVED_KEY:
            raise ImproperlyConfigured("Set CHAT_ENCRYPTION_KEYS to encrypt chat messages.")
        # Development only: a key derived from SECRET_KEY, so chat works without extra setup.
        keys = [base64.urlsafe_b64encode(hashlib.sha256(f"chat:{settings.SECRET_KEY}".encode()).digest()).decode()]
    return MultiFernet([Fernet(k) for k in keys])


def encrypt(text):
    return _fernet().encrypt(text.encode()).decode()


def decrypt(token):
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return "[This message can't be decrypted]"
