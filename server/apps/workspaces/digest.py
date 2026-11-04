"""Workspace emails. Notifications reach the app and phones at once; email waits a little and goes
as one message per person. Adding ten rows shouldn't send ten emails, and Brevo's free plan allows
300 a day, so sign-in codes always keep room. Runs from the every-minute job."""

from datetime import timedelta

from django.conf import settings
from django.db.models import Min
from django.utils import timezone

from apps.users import mail
from apps.users.language import tr
from apps.users.models import EmailLog

from .models import Notification

EMAILED_KINDS = [Notification.Kind.NEW_WORK, Notification.Kind.DONE]
WAIT = timedelta(minutes=2)
TOO_OLD = timedelta(days=7)
MAX_ITEMS = 8
MAX_PER_RUN = 20
DAILY_LIMIT = 200  # of the 300, leaving 100 for sign-in codes and invitations


def _context(items):
    first = items[0]
    language = first.recipient.language
    workspaces = {item.workspace.name for item in items}
    count = len(items)
    place = workspaces.pop() if len(workspaces) == 1 else tr(language, "your workspaces")
    base = settings.APP_URL.rstrip("/")
    return {
        "language": language,
        "eyebrow": place,
        "heading": first.title if count == 1 else tr(language, "{count} updates in {place}", count=count, place=place),
        "items": [{"title": item.title, "body": item.body} for item in items[:MAX_ITEMS]],
        "more": max(count - MAX_ITEMS, 0),
        "open_url": f"{base}{first.url}" if count == 1 else f"{base}/notifications",
        "open_label": tr(language, "Open it") if count == 1 else tr(language, "See what changed"),
        "preheader": first.title,
    }


def send_due_emails(now=None):
    """Returns how many emails went out."""
    now = now or timezone.now()
    waiting = Notification.objects.filter(kind__in=EMAILED_KINDS, emailed_at__isnull=True)
    # Already seen, switched off, or sent while the daily limit was reached long ago: no email.
    waiting.filter(read_at__isnull=False).update(emailed_at=now)
    waiting.filter(recipient__workspace_emails=False).update(emailed_at=now)
    waiting.filter(recipient__email_verified_at__isnull=True).update(emailed_at=now)
    waiting.filter(created_at__lt=now - TOO_OLD).update(emailed_at=now)

    room = DAILY_LIMIT - EmailLog.objects.filter(kind="workspace_update", created_at__gte=now - timedelta(days=1)).count()
    due = waiting.order_by().values("recipient").annotate(oldest=Min("created_at")).filter(oldest__lte=now - WAIT).order_by("oldest")
    sent = 0
    for entry in due[: max(min(room, MAX_PER_RUN), 0)]:
        items = list(waiting.filter(recipient_id=entry["recipient"]).select_related("workspace", "recipient").order_by("created_at", "id"))
        # Claimed first: two runs at once can't send the same update twice. A failed send isn't
        # retried, since it's in the app anyway; staff see the failure in the admin dashboard.
        if not items or not waiting.filter(pk__in=[item.pk for item in items]).update(emailed_at=now):
            continue
        context = _context(items)
        subject = context["heading"]
        if mail.send_now(to=items[0].recipient.email, subject=subject, template="workspace_update", context=context):
            sent += 1
    return sent
