"""6-digit email codes (verify email, new-device sign-in) and trusted devices."""

import hashlib
import hmac
import re
import secrets
from datetime import timedelta

from django.conf import settings
from django.core import signing
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from . import mail
from .models import EmailCode, TrustedDevice, User

CHALLENGE_SALT = "login-2fa"


def _hash(value):
    return hmac.new(settings.SECRET_KEY.encode(), value.encode(), hashlib.sha256).hexdigest()


def issue_code(user, purpose, challenge="", device=""):
    """Send a fresh code. Resends are spaced out and capped per hour, so the inbox (and our Gmail
    sending limit) can't be flooded."""
    now = timezone.now()
    recent = EmailCode.objects.filter(user=user, purpose=purpose, created_at__gte=now - timedelta(hours=1))
    # The wait only applies while the last code is still waiting to be used.
    last = recent.filter(used_at__isnull=True).order_by("-created_at").first()
    if last and (now - last.created_at).total_seconds() < settings.OTP_RESEND_SECONDS:
        wait = settings.OTP_RESEND_SECONDS - int((now - last.created_at).total_seconds())
        raise ValidationError({"detail": f"Please wait {wait} seconds before asking for another code.", "retry_after": wait})
    if recent.count() >= settings.OTP_MAX_SENDS_PER_HOUR:
        raise ValidationError({"detail": "Too many codes requested. Try again in an hour."})

    # Only the newest code works.
    EmailCode.objects.filter(user=user, purpose=purpose, used_at__isnull=True).update(used_at=now)
    code = f"{secrets.randbelow(10**6):06d}"
    EmailCode.objects.create(
        user=user,
        purpose=purpose,
        challenge=challenge,
        code_hash=_hash(f"{user.pk}:{purpose}:{challenge}:{code}"),
        expires_at=now + timedelta(minutes=settings.OTP_TTL_MINUTES),
    )
    mail.send_code(to=user.email, purpose=purpose, code=code, device=device)
    return settings.OTP_RESEND_SECONDS


def code_expires_at(user, purpose, challenge=None):
    """When the code waiting to be used runs out (None if there isn't one), for the app's countdown."""
    codes = EmailCode.objects.filter(user=user, purpose=purpose, used_at__isnull=True, expires_at__gt=timezone.now())
    if challenge is not None:
        codes = codes.filter(challenge=challenge)
    latest = codes.order_by("-created_at").first()
    return latest.expires_at if latest else None


def check_code(user, purpose, code, challenge=""):
    """Raises ValidationError with a helpful message unless the code is right."""
    code = re.sub(r"\D", "", str(code or ""))
    now = timezone.now()
    entry = (
        EmailCode.objects.filter(user=user, purpose=purpose, challenge=challenge, used_at__isnull=True)
        .order_by("-created_at")
        .first()
    )
    if entry is None or entry.expires_at < now:
        raise ValidationError({"code": ["This code has expired. Send a new one."]})
    entry.attempts += 1
    if entry.attempts > settings.OTP_MAX_ATTEMPTS:
        entry.used_at = now
        entry.save(update_fields=["attempts", "used_at"])
        raise ValidationError({"code": ["Too many wrong tries. Send a new code."]})
    if len(code) != 6 or not hmac.compare_digest(entry.code_hash, _hash(f"{user.pk}:{purpose}:{challenge}:{code}")):
        entry.save(update_fields=["attempts"])
        left = settings.OTP_MAX_ATTEMPTS - entry.attempts
        raise ValidationError({"code": [f"That code isn't right. {left} {'try' if left == 1 else 'tries'} left." if left else "That code isn't right."]})
    entry.used_at = now
    entry.save(update_fields=["attempts", "used_at"])


# --- sign-in challenges --------------------------------------------------------------------

def make_challenge(user, restore=False):
    """A signed, short-lived ticket saying "this person got the password right" (and, for a
    deleted account, "and asked to restore it")."""
    nonce = secrets.token_urlsafe(16)
    return signing.dumps({"u": user.pk, "n": nonce, "r": restore}, salt=CHALLENGE_SALT), nonce


def start_login(user, device="", restore=False):
    """Begin a new-device sign-in: returns (challenge, resend_in). Pressing "Log in" again right
    after reuses the code that was just sent instead of failing on the resend wait."""
    now = timezone.now()
    last = (
        EmailCode.objects.filter(user=user, purpose=EmailCode.Purpose.LOGIN, used_at__isnull=True, expires_at__gt=now)
        .order_by("-created_at")
        .first()
    )
    if last and (now - last.created_at).total_seconds() < settings.OTP_RESEND_SECONDS:
        wait = settings.OTP_RESEND_SECONDS - int((now - last.created_at).total_seconds())
        return signing.dumps({"u": user.pk, "n": last.challenge, "r": restore}, salt=CHALLENGE_SALT), wait
    challenge, nonce = make_challenge(user, restore)
    return challenge, issue_code(user, EmailCode.Purpose.LOGIN, challenge=nonce, device=device)


def read_challenge(token):
    try:
        data = signing.loads(token or "", salt=CHALLENGE_SALT, max_age=settings.OTP_TTL_MINUTES * 60)
    except signing.BadSignature:
        raise ValidationError({"detail": "This sign-in attempt has expired. Log in again."})
    from .services import restore_deadline  # services imports this module

    user = User.all_objects.filter(pk=data["u"]).first()
    restoring = bool(data.get("r"))
    usable = user is not None and (
        (user.is_active and not user.deleted_at) or (restoring and user.deleted_at and timezone.now() < restore_deadline(user))
    )
    if not usable:
        raise ValidationError({"detail": "This sign-in attempt has expired. Log in again."})
    return user, data["n"], restoring


# --- trusted devices ----------------------------------------------------------------------

def device_name(user_agent):
    """'Safari on macOS'-style label from the User-Agent; good enough to recognise your devices."""
    ua = user_agent or ""
    browser = next(
        (name for key, name in [("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("CriOS", "Chrome"), ("Chrome/", "Chrome"), ("Safari/", "Safari")] if key in ua),
        "Browser",
    )
    system = next(
        (name for key, name in [("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Mac OS X", "macOS"), ("Windows", "Windows"), ("Linux", "Linux")] if key in ua),
        "",
    )
    return f"{browser} on {system}" if system else browser


def find_trusted(request, user):
    token = request.COOKIES.get(settings.TRUSTED_DEVICE_COOKIE)
    if not token:
        return None
    device = TrustedDevice.objects.filter(user=user, token_hash=_hash(token)).first()
    if device and device.created_at < timezone.now() - timedelta(days=settings.TRUSTED_DEVICE_DAYS):
        device.delete()
        return None
    return device


def trust_device(request, response, user, ip=None):
    token = secrets.token_urlsafe(32)
    TrustedDevice.objects.create(user=user, token_hash=_hash(token), name=device_name(request.headers.get("User-Agent")), ip_address=ip)
    response.set_cookie(
        settings.TRUSTED_DEVICE_COOKIE,
        token,
        max_age=settings.TRUSTED_DEVICE_DAYS * 24 * 3600,
        httponly=True,
        secure=settings.REFRESH_COOKIE_SECURE,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
        path=settings.REFRESH_COOKIE_PATH,
    )


def current_device_hash(request):
    token = request.COOKIES.get(settings.TRUSTED_DEVICE_COOKIE)
    return _hash(token) if token else None


def mask_email(email):
    local, _, domain = email.partition("@")
    return f"{local[:2]}•••@{domain}"
