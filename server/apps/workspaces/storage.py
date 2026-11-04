"""Where workspace files live. Render's disk is wiped on every deploy, so files go to a private
Supabase Storage bucket. The browser uploads straight to it with a short-lived link, which is what
makes real progress possible and keeps big files away from our small server. Reading works the
same way: this server checks your role, then hands out a link that soon expires.

Locally (FILE_STORAGE=local) files go to a folder instead, through the views in dev_files.py.
"""

import logging
from pathlib import Path
from urllib.parse import quote

import requests
from django.conf import settings
from django.core import signing

logger = logging.getLogger(__name__)

TIMEOUT = 15
PEEK_BYTES = 32
DEV_SALT = "workspace-dev-file"


def enabled():
    if settings.FILE_STORAGE == "local":
        return True
    return settings.FILE_STORAGE == "supabase" and bool(settings.SUPABASE_URL and settings.SUPABASE_SECRET_KEY)


def _base():
    return f"{settings.SUPABASE_URL.rstrip('/')}/storage/v1"


def _headers():
    key = settings.SUPABASE_SECRET_KEY
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def _object(key):
    return f"{settings.SUPABASE_BUCKET}/{quote(key)}"


def _is_local():
    return settings.FILE_STORAGE == "local"


def _local_path(key):
    root = Path(settings.FILE_DEV_DIR).resolve()
    path = (root / key).resolve()
    if root not in path.parents:
        raise ValueError("Bad file key")
    return path


def _dev_url(key, action):
    return f"/api/workspaces/files/dev/{signing.dumps({'k': key, 'a': action}, salt=DEV_SALT)}/"


def read_dev_token(token, action, max_age):
    data = signing.loads(token, salt=DEV_SALT, max_age=max_age)
    if data["a"] != action:
        raise signing.BadSignature("Wrong action")
    return _local_path(data["k"])


def upload_target(key, content_type):
    """Where the browser sends this file, and the headers to send with it."""
    headers = {"Content-Type": content_type}
    if _is_local():
        return {"url": _dev_url(key, "put"), "headers": headers}
    response = requests.post(f"{_base()}/object/upload/sign/{_object(key)}", json={}, headers=_headers(), timeout=TIMEOUT)
    response.raise_for_status()
    return {"url": f"{_base()}{response.json()['url']}", "headers": {**headers, "x-upsert": "false", "cache-control": "max-age=31536000"}}


def sign(keys, seconds):
    """Links for reading these files, as {key: url}. A file that can't be signed is left out."""
    keys = list(keys)
    if not keys:
        return {}
    if _is_local():
        return {key: _dev_url(key, "get") for key in keys}
    response = requests.post(
        f"{_base()}/object/sign/{settings.SUPABASE_BUCKET}", json={"expiresIn": seconds, "paths": keys}, headers=_headers(), timeout=TIMEOUT
    )
    response.raise_for_status()
    return {item["path"]: f"{_base()}{item['signedURL']}" for item in response.json() if item.get("signedURL")}


def peek(key):
    """The real size of an uploaded file and its first bytes, or None if it isn't there."""
    if _is_local():
        path = _local_path(key)
        if not path.is_file():
            return None
        with path.open("rb") as file:
            return path.stat().st_size, file.read(PEEK_BYTES)
    headers = {**_headers(), "Range": f"bytes=0-{PEEK_BYTES - 1}"}
    with requests.get(f"{_base()}/object/{_object(key)}", headers=headers, timeout=TIMEOUT, stream=True) as response:
        if response.status_code in (400, 404):
            return None
        response.raise_for_status()
        head = next(response.iter_content(PEEK_BYTES), b"")[:PEEK_BYTES]
        total = response.headers.get("Content-Range", "").rpartition("/")[2]
        return int(total if total.isdigit() else response.headers.get("Content-Length", len(head))), head


def remove(keys):
    keys = [key for key in keys if key]
    if not keys:
        return
    if _is_local():
        for key in keys:
            _local_path(key).unlink(missing_ok=True)
        return
    response = requests.delete(f"{_base()}/object/{settings.SUPABASE_BUCKET}", json={"prefixes": keys}, headers=_headers(), timeout=TIMEOUT)
    response.raise_for_status()


def remove_quietly(keys):
    """After a record is gone. A leftover file is only wasted space, so it never stops anything."""
    if not enabled():
        return
    try:
        remove(keys)
    except (requests.RequestException, OSError, ValueError):
        logger.exception("Couldn't delete %d stored files", len(keys))
