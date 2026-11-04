import logging
from datetime import timedelta
from zoneinfo import ZoneInfo

from django.db.models import Q
from django.utils import timezone

from apps.tasks.models import Task
from apps.users.language import tr

from .push import send_push

logger = logging.getLogger(__name__)

# Reminders for tasks that are already this far past due are dropped instead of sent late.
STALE_AFTER = timedelta(hours=1)
MAX_LEAD = timedelta(days=1)
# A reminder that couldn't be sent, or whose run died part way, is tried again after this long.
RETRY_AFTER = timedelta(minutes=2)


def _not_being_sent(now):
    return Q(reminder_claimed_at__isnull=True) | Q(reminder_claimed_at__lte=now - RETRY_AFTER)


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
    ).filter(_not_being_sent(now))
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
    owner = task.owner
    text = tr(owner, "Starts in {lead} · {at}", lead=_lead(minutes, owner), at=at) if minutes > 0 else tr(owner, "Due now · {at}", at=at)
    return tr(owner, "High priority · {text}", text=text) if task.priority == Task.Priority.HIGH else text


def _lead(minutes, owner=None):
    """45 -> '45 min', 90 -> '1 h 30 min', 120 -> '2 h', 1440 -> '1 day'."""
    if minutes >= 24 * 60:
        days = round(minutes / (24 * 60))
        return tr(owner, "{days} days", days=days) if owner and owner.language == "my" else f"{days} day{'s' if days != 1 else ''}"
    hours, rest = divmod(minutes, 60)
    if not hours:
        return tr("en" if owner is None else owner, "{minutes} min", minutes=rest)
    who = "en" if owner is None else owner
    return tr(who, "{hours} h {minutes} min", hours=hours, minutes=rest) if rest else tr(who, "{hours} h", hours=hours)


def _send_to_devices(task, now):
    """(reached a device or has none to try, how many devices failed)."""
    subscriptions = list(task.owner.push_subscriptions.all())
    body = _reminder_body(task, now)
    urgent = task.priority == Task.Priority.HIGH
    reached = not subscriptions
    failed = 0
    for subscription in subscriptions:
        try:
            send_push(subscription, task.title, body, url="/", urgent=urgent, time_sensitive=True)
            reached = True
        except Exception as exc:  # one bad device or a network failure mustn't stop anyone else's reminder
            failed += 1
            logger.warning("Push to %s failed: %s", subscription, exc)
    return reached, failed


def send_due_reminders(now=None):
    """Push every due reminder to its owner's devices. Returns how many tasks were reminded.
    A reminder only counts as sent once it reached a device. Until then it's tried again every
    couple of minutes, up to an hour after the task's time."""
    from .models import ReminderRun

    now = now or timezone.now()
    sent = failed = 0
    try:
        for task in due_reminders(now):
            # Claim the task first: if two senders run at once (cron + loop, or two workers), only
            # one wins the update, so nobody gets the same reminder twice.
            if not Task.objects.filter(_not_being_sent(now), pk=task.pk, reminder_sent_at__isnull=True).update(reminder_claimed_at=now):
                continue
            try:
                reached, failures = _send_to_devices(task, now)
            except Exception:
                logger.exception("Couldn't send the reminder for task %s", task.pk)
                failed += 1
                continue
            failed += failures
            if reached:
                Task.objects.filter(pk=task.pk).update(reminder_sent_at=now)
                sent += 1
    finally:
        # Even after a failure: the "Check reminders" panel must show the job is still running.
        ReminderRun.record(sent, failed)
    return sent
