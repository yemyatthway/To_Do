import logging
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.utils import timezone
from pywebpush import WebPushException

from apps.tasks.models import Task

from .push import send_push

logger = logging.getLogger(__name__)

# Reminders for tasks that are already this far past due are dropped instead of sent late.
STALE_AFTER = timedelta(hours=1)
MAX_LEAD = timedelta(days=1)


def due_reminders(now):
    """Tasks whose reminder time has arrived, for users who have reminders turned on."""
    candidates = Task.objects.select_related("owner").prefetch_related("owner__push_subscriptions").filter(
        owner__reminders_enabled=True,
        owner__is_active=True,
        done=False,
        reminder_sent_at__isnull=True,
        remind_before_minutes__isnull=False,
        due_at__gte=now - STALE_AFTER,
        due_at__lte=now + MAX_LEAD,
    )
    return [t for t in candidates if t.due_at - timedelta(minutes=t.remind_before_minutes) <= now]


def _owner_zone(user):
    try:
        return ZoneInfo(user.timezone) if user.timezone else timezone.get_current_timezone()
    except Exception:
        return timezone.get_current_timezone()


def _reminder_body(task, now):
    # Written in the owner's own time zone, wherever they are.
    at = task.due_at.astimezone(_owner_zone(task.owner)).strftime("%-I:%M %p")
    minutes = round((task.due_at - now).total_seconds() / 60)
    text = f"Starts in {minutes} min · {at}" if minutes > 0 else f"Due now · {at}"
    return f"High priority · {text}" if task.priority == Task.Priority.HIGH else text


def send_due_reminders(now=None):
    """Push every due reminder to its owner's browsers. Returns how many tasks were reminded."""
    from .models import ReminderRun

    now = now or timezone.now()
    sent = failed = 0
    for task in due_reminders(now):
        # Claim the task first: if two senders run at once (cron + loop, or two workers), only one
        # wins the update, so nobody gets the same reminder twice.
        if not Task.objects.filter(pk=task.pk, reminder_sent_at__isnull=True).update(reminder_sent_at=now):
            continue
        sent += 1
        for subscription in task.owner.push_subscriptions.all():
            try:
                send_push(subscription, task.title, _reminder_body(task, now), url="/", urgent=task.priority == Task.Priority.HIGH)
            except WebPushException as exc:
                failed += 1
                logger.warning("Push to %s failed: %s", subscription, exc)
    ReminderRun.record(sent, failed)
    return sent
