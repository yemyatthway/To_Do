import logging
import threading

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.utils import timezone

from .models import User

logger = logging.getLogger("apps.users.mail")

# Code emails stay short and link-free: that keeps them out of spam and away from phishing
# lookalikes. Every email has a plain-text part too (templates/emails/<name>.txt).

WELCOME_FEATURES = [
    {"icon": "🕒", "title": "Your day on a clock", "body": "The clock shows the next 12 hours. Tap an hour to see its tasks, or press and hold to add one right there."},
    {"icon": "🔔", "title": "Reminders that find you", "body": "Turn on the bell and get a notification before each task, even when the app is closed."},
    {"icon": "🚩", "title": "Priorities", "body": "High-priority tasks go first in your list, stand out on the clock and their reminders stay on screen."},
    {"icon": "👋", "title": "Friends", "body": "Add friends and send them copies of your tasks, like a shopping list or a plan for the weekend."},
]


def _deliver(message):
    try:
        message.send(fail_silently=False)
    except Exception:
        # Never crash a request over email; the person can ask for a new code.
        logger.exception("Couldn't send email to %s", message.to)


def render(template, context):
    """(text, html) for templates/emails/<template>.txt and .html."""
    return render_to_string(f"emails/{template}.txt", context), render_to_string(f"emails/{template}.html", context)


def send(*, to, subject, template, context):
    context = {"subject": subject, **context}
    text, html = render(template, context)
    message = EmailMultiAlternatives(subject, text, settings.DEFAULT_FROM_EMAIL, [to])
    message.attach_alternative(html, "text/html")
    if settings.EMAIL_SEND_ASYNC:
        threading.Thread(target=_deliver, args=(message,), daemon=True).start()
    else:
        _deliver(message)


def code_context(purpose, code, device=""):
    if purpose == "login":
        return {
            "heading": "Your sign-in code",
            "intro": "Someone is signing in to your To-Do account from a new device. If it's you, enter this code to finish.",
            "preheader": f"{code} is your sign-in code. It expires in {settings.OTP_TTL_MINUTES} minutes.",
            "code": code,
            "minutes": settings.OTP_TTL_MINUTES,
            "device": device or "a new browser",
        }
    return {
        "heading": "Confirm your email",
        "intro": "Thanks for signing up! Enter this code in the app to confirm it's really your address.",
        "preheader": f"{code} is your verification code. It expires in {settings.OTP_TTL_MINUTES} minutes.",
        "code": code,
        "minutes": settings.OTP_TTL_MINUTES,
        "device": "",
    }


def send_code(*, to, purpose, code, device=""):
    word = "sign-in" if purpose == "login" else "verification"
    send(to=to, subject=f"{code} is your To-Do {word} code", template="code", context=code_context(purpose, code, device))


def welcome_context(user):
    first = (user.full_name or "").split()[0] if user.full_name.strip() else ""
    return {
        "name": first,
        "features": WELCOME_FEATURES,
        "app_url": settings.APP_URL,
        "preheader": "Your account is ready. Here's how to get the most out of To-Do.",
    }


def send_welcome_once(user):
    """The welcome email, sent the first time someone signs in with a confirmed address.
    Claimed with one UPDATE, so two sign-ins at once can't send it twice."""
    if not user.email_verified:
        return False
    if not User.all_objects.filter(pk=user.pk, welcomed_at__isnull=True).update(welcomed_at=timezone.now()):
        return False
    send(to=user.email, subject="Welcome to To-Do 🎉", template="welcome", context=welcome_context(user))
    return True
