"""Usernames: the public, unique handle people find each other by (@ryen.kai).

3–20 characters: lowercase letters, numbers, "." and "_", starting and ending with a letter or
number, no ".." in a row. Stored lowercase, so "Kai" and "kai" are the same name.
"""

import re
import unicodedata

MIN_LENGTH = 3
MAX_LENGTH = 20
PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$")
# Names that would look official or confuse people.
RESERVED = {
    "admin", "administrator", "api", "app", "help", "me", "mod", "moderator", "null", "official",
    "root", "staff", "support", "system", "todo", "todoclock", "undefined", "you",
}


def normalize(value):
    return (value or "").strip().lstrip("@").lower()


def problem(value):
    """What's wrong with this username's shape, or None. (Whether it's taken is checked separately.)"""
    if len(value) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(value) > MAX_LENGTH:
        return f"Use at most {MAX_LENGTH} characters."
    if not PATTERN.match(value):
        return "Use lowercase letters, numbers, dots and underscores, starting and ending with a letter or number."
    if ".." in value:
        return "No two dots in a row."
    if value in RESERVED:
        return "That username isn't available."
    return None


def is_taken(value, exclude=None):
    from .models import User

    # Recently deleted accounts keep theirs while they can still be restored.
    taken = User.all_objects.filter(username=value)
    if exclude is not None:
        taken = taken.exclude(pk=exclude.pk)
    return taken.exists()


def free_variant(value, taken=is_taken):
    """lin.aye is taken -> lin.aye2 (or the next free number)."""
    number = 1
    candidate = value
    while taken(candidate):
        number += 1
        candidate = value[: MAX_LENGTH - len(str(number))].rstrip("._") + str(number)
    return candidate


def slug(text):
    """"Ryen Kai" -> "ryenkai", "Zoë O'Neil" -> "zoeoneil": just the letters and numbers."""
    ascii_text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", ascii_text.lower())


def suggest(full_name, email, taken=is_taken):
    """A free username from the name (or the email's first part): ryenkai, then ryenkai2, ryenkai3..."""
    base = slug(full_name) or slug((email or "").partition("@")[0]) or "user"
    base = base[:MAX_LENGTH]
    if len(base) < MIN_LENGTH:
        base = (base + "user")[:MAX_LENGTH]
    if base in RESERVED:
        base = base + "1"
    candidate, number = base, 1
    while taken(candidate):
        number += 1
        suffix = str(number)
        candidate = base[: MAX_LENGTH - len(suffix)] + suffix
    return candidate
