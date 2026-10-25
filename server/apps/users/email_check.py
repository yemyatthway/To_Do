"""Is this an email address that can actually receive mail?

We can't prove a mailbox exists without sending to it (that's what the verification code is for),
but we can catch most mistakes up front: bad format, a domain that doesn't exist or can't receive
mail, throwaway inboxes, and typos of big providers ("gmial.com").
"""

import difflib

import dns.exception
import dns.resolver
from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.validators import validate_email

COMMON_DOMAINS = [
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "icloud.com",
    "me.com",
    "proton.me",
    "protonmail.com",
    "aol.com",
    "yandex.com",
    "zoho.com",
]

# Throwaway inboxes (a short list of the most common; extend as needed).
DISPOSABLE_DOMAINS = {
    "mailinator.com",
    "10minutemail.com",
    "guerrillamail.com",
    "sharklasers.com",
    "tempmail.com",
    "temp-mail.org",
    "yopmail.com",
    "trashmail.com",
    "getnada.com",
    "dispostable.com",
    "maildrop.cc",
    "throwawaymail.com",
    "fakeinbox.com",
    "emailondeck.com",
    "moakt.com",
    "mohmal.com",
    "tempail.com",
}

# Reserved names used in development and tests never resolve (see EMAIL_ALLOW_RESERVED_DOMAINS).
DEV_DOMAINS = ("example.com", "example.org", "example.net")
DEV_SUFFIXES = (".test", ".localhost", ".example")


def suggest_domain(domain):
    """'gmial.com' -> 'gmail.com'. None when it already looks right."""
    if domain in COMMON_DOMAINS:
        return None
    match = difflib.get_close_matches(domain, COMMON_DOMAINS, n=1, cutoff=0.82)
    return match[0] if match else None


def domain_accepts_mail(domain):
    """True if the domain has mail servers (MX, or an address record as the fallback mail host).
    Cached for a day. If DNS itself is unreachable we don't block sign-up: the code email decides."""
    key = f"mx:{domain}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    resolver = dns.resolver.Resolver()
    resolver.lifetime = 3.0
    try:
        answers = resolver.resolve(domain, "MX")
        # A "null MX" (RFC 7505) explicitly says the domain takes no mail.
        ok = any(str(r.exchange).rstrip(".") for r in answers)
    except dns.resolver.NoAnswer:
        try:
            resolver.resolve(domain, "A")
            ok = True
        except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
            ok = False
        except dns.exception.DNSException:
            return True
    except (dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
        ok = False
    except dns.exception.DNSException:
        return True  # timeout etc.: don't cache, don't block
    cache.set(key, ok, 60 * 60 * 24)
    return ok


def email_checks(email):
    """Each rule separately, for the live checklist under the sign-up email field.
    None means "not checked yet" (an earlier rule already failed)."""
    email = (email or "").strip().lower()
    try:
        validate_email(email)
    except ValidationError:
        return {"format": False, "real_inbox": None, "receives_mail": None}
    domain = email.rpartition("@")[2]
    if settings.EMAIL_ALLOW_RESERVED_DOMAINS and (domain in DEV_DOMAINS or domain.endswith(DEV_SUFFIXES)):
        return {"format": True, "real_inbox": True, "receives_mail": True}
    if domain in DISPOSABLE_DOMAINS:
        return {"format": True, "real_inbox": False, "receives_mail": None}
    return {"format": True, "real_inbox": True, "receives_mail": domain_accepts_mail(domain)}


def check_email(email):
    """Returns (ok, message, suggestion). message explains the problem when ok is False."""
    email = (email or "").strip().lower()
    try:
        validate_email(email)
    except ValidationError:
        return False, "Enter a valid email address, like name@example.com.", None
    local, _, domain = email.rpartition("@")
    suggestion = suggest_domain(domain)
    suggested_email = f"{local}@{suggestion}" if suggestion else None

    if settings.EMAIL_ALLOW_RESERVED_DOMAINS and (domain in DEV_DOMAINS or domain.endswith(DEV_SUFFIXES)):
        return True, "", None
    if domain in DISPOSABLE_DOMAINS:
        return False, "Temporary email addresses can't be used. Use your regular email.", None
    if not domain_accepts_mail(domain):
        if suggested_email:
            # The app shows the suggestion as a one-tap fix right under this message.
            return False, f"{domain} can't receive email.", suggested_email
        return False, f"{domain} can't receive email. Check the address for typos.", None
    return True, "", suggested_email
