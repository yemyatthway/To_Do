"""Print a fresh VAPID key pair as .env lines (base64url, the format browsers and pywebpush expect)."""

import base64

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


vapid = Vapid()
vapid.generate_keys()

private_raw = vapid.private_key.private_numbers().private_value.to_bytes(32, "big")
public_raw = vapid.public_key.public_bytes(
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
)

print(f"VAPID_PUBLIC_KEY={b64url(public_raw)}")
print(f"VAPID_PRIVATE_KEY={b64url(private_raw)}")
