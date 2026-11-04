import logging
import threading

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import close_old_connections
from django.template.loader import render_to_string
from django.utils import timezone

from .language import tr
from .models import EmailLog, User

logger = logging.getLogger("apps.users.mail")

# Code emails stay short and link-free: that keeps them out of spam and away from phishing
# lookalikes. Every email has a plain-text part too (templates/emails/<name>.txt).

WELCOME_FEATURES = [
    {"icon": "clock", "title": "Your day on a clock", "body": "The clock shows the next 12 hours. Tap an hour to see its tasks, or press and hold to add one right there."},
    {"icon": "bell", "title": "Reminders that find you", "body": "Turn on the bell and get a notification before each task, even when the app is closed."},
    {"icon": "flag", "title": "Priorities", "body": "High-priority tasks go first in your list, stand out on the clock and their reminders stay on screen."},
    {"icon": "users", "title": "Friends", "body": "Add friends and send them copies of your tasks, like a shopping list or a plan for the weekend."},
]


def _record(kind, to, ok, error=""):
    """What staff see in Admin > Emails. Never gets in the way of the email itself."""
    from apps.live import ably
    from apps.social.services import mask_email

    try:
        entry = EmailLog.objects.create(kind=kind, recipient=mask_email(to), ok=ok, error=str(error)[:200])
        ably.to_admins("email", {"id": entry.pk, "ok": ok})
    except Exception:
        logger.exception("Couldn't record an email result")


def _deliver(message, kind="email"):
    """Sends it, records how that went and says whether it worked."""
    to = message.to[0]
    try:
        message.send(fail_silently=False)
    except Exception as error:
        # Never crash a request over email; the person can ask for a new code.
        logger.exception("Couldn't send email to %s", message.to)
        _record(kind, to, False, error)
        return False
    _record(kind, to, True)
    return True


def _deliver_in_background(message, kind):
    close_old_connections()
    try:
        _deliver(message, kind)
    finally:
        close_old_connections()


def render(template, context):
    """(text, html) for templates/emails/<template>.txt and .html."""
    # Icons are PNGs served by the app (client/public/email/): email apps block SVG and icon fonts.
    context = {"icons": f"{settings.APP_URL.rstrip('/')}/email/", **context}
    return render_to_string(f"emails/{template}.txt", context), render_to_string(f"emails/{template}.html", context)


def _build(to, subject, template, context):
    context = {"subject": subject, **context}
    text, html = render(template, context)
    message = EmailMultiAlternatives(subject, text, settings.DEFAULT_FROM_EMAIL, [to])
    message.attach_alternative(html, "text/html")
    return message


def send(*, to, subject, template, context):
    message = _build(to, subject, template, context)
    if settings.EMAIL_SEND_ASYNC:
        threading.Thread(target=_deliver_in_background, args=(message, template), daemon=True).start()
    else:
        _deliver(message, template)


def send_now(*, to, subject, template, context):
    """For scheduled work: waits for the mail server and says whether it worked."""
    return _deliver(_build(to, subject, template, context), template)


def code_context(purpose, code, device="", language="en"):
    minutes = settings.OTP_TTL_MINUTES
    if purpose == "login":
        return {
            "language": language,
            "eyebrow": tr(language, "New device sign-in"),
            "heading": tr(language, "Your sign-in code"),
            "intro": tr(language, "Someone is signing in to your Todo Clock account from a new device. If it's you, enter this code to finish."),
            "preheader": tr(language, "{code} is your sign-in code. It expires in {minutes} minutes.", code=code, minutes=minutes),
            "code": code,
            "minutes": minutes,
            "device": device or tr(language, "a new browser"),
        }
    return {
        "language": language,
        "eyebrow": tr(language, "Verify your email"),
        "heading": tr(language, "Confirm your email"),
        "intro": tr(language, "Thanks for signing up! Enter this code in the app to confirm it's really your address."),
        "preheader": tr(language, "{code} is your verification code. It expires in {minutes} minutes.", code=code, minutes=minutes),
        "code": code,
        "minutes": minutes,
        "device": "",
    }


def send_code(*, to, purpose, code, device="", language="en"):
    subject = "{code} is your Todo Clock sign-in code" if purpose == "login" else "{code} is your Todo Clock verification code"
    send(to=to, subject=tr(language, subject, code=code), template="code", context=code_context(purpose, code, device, language))


def welcome_context(user):
    first = (user.full_name or "").split()[0] if user.full_name.strip() else ""
    return {
        "language": user.language,
        "name": first,
        "features": [{**feature, "title": tr(user, feature["title"]), "body": tr(user, feature["body"])} for feature in WELCOME_FEATURES],
        "app_url": settings.APP_URL,
        "preheader": tr(user, "Your account is ready. Here's how to get the most out of Todo Clock."),
    }


def send_welcome_once(user):
    """The welcome email, sent the first time someone signs in with a confirmed address.
    Claimed with one UPDATE, so two sign-ins at once can't send it twice."""
    if not user.email_verified:
        return False
    if not User.all_objects.filter(pk=user.pk, welcomed_at__isnull=True).update(welcomed_at=timezone.now()):
        return False
    send(to=user.email, subject=tr(user, "Welcome to Todo Clock"), template="welcome", context=welcome_context(user))
    return True
