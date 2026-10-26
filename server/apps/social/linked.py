"""'Remind a friend': put a copy of your task straight into a friend's list, kept in sync.

Each friend gets their own Task (linked_from = your task), so their reminders, done state and
Recently deleted work exactly like their own tasks. It's one shared plan, edited by anyone: a
change to the time, title, notes, category or priority by any member reaches everyone's copy and
the others are notified. Done stays personal. The creator deleting it cancels it for everyone; a
friend deleting theirs just leaves.
"""

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.tasks.models import Task
from apps.tasks.serializers import user_zone
from apps.users.models import User

from .models import Friendship
from .services import MAX_TASKS_PER_SHARE, _notify, share_tasks

SYNCED_FIELDS = ("title", "notes", "due_at", "category", "priority")
DEFAULT_REMIND_MINUTES = 10


def _name(user):
    return user.full_name or user.email


def when(task, viewer):
    """'7:00 PM' today, 'Sat, Oct 31 · 7:00 PM' another day, in the viewer's own time zone."""
    if task.due_at is None:
        return "Anytime"
    zone = user_zone(viewer)
    local = timezone.localtime(task.due_at, zone)
    time = local.strftime("%I:%M %p").lstrip("0")
    if local.date() == timezone.localtime(timezone.now(), zone).date():
        return time
    return f"{local.strftime('%a, %b')} {local.day} · {time}"


def add_for_friend(*, me, recipient_id, task_ids):
    """Returns {"mode": "added", "added": n, "already": n, "past": n} or, if the friend only
    accepts tasks through the inbox, the share that was sent instead ({"mode": "inbox", ...})."""
    recipient = User.objects.filter(pk=recipient_id, is_active=True).first()
    if recipient is None or not Friendship.are_friends(me, recipient):
        raise PermissionDenied("You can only remind friends.")
    task_ids = list(dict.fromkeys(task_ids))[:MAX_TASKS_PER_SHARE]
    tasks = list(Task.objects.filter(owner=me, pk__in=task_ids))
    if not tasks:
        raise ValidationError({"task_ids": ["Pick at least one of your tasks."]})

    if not recipient.friends_can_add_tasks:
        share = share_tasks(me=me, recipient_id=recipient.pk, task_ids=[t.pk for t in tasks])
        return {"mode": "inbox", "share_id": share.pk, "added": 0, "already": 0, "past": 0}

    now = timezone.now()
    upcoming = [t for t in tasks if t.due_at is None or t.due_at > now]
    past = len(tasks) - len(upcoming)
    # A copy of a copy follows the same original, so everyone stays on one version.
    roots = {t.pk: (t.linked_from_id or t.pk) for t in upcoming}
    have = set(Task.objects.filter(owner=recipient, linked_from_id__in=roots.values()).values_list("linked_from_id", flat=True))
    # Never send a task back to the friend it originally came from.
    theirs = set(Task.all_objects.filter(pk__in=roots.values(), owner=recipient).values_list("pk", flat=True))
    fresh = [t for t in upcoming if roots[t.pk] not in have and roots[t.pk] not in theirs]

    with transaction.atomic():
        copies = Task.objects.bulk_create(
            Task(
                owner=recipient,
                linked_from_id=roots[t.pk],
                added_by=me,
                title=t.title,
                notes=t.notes,
                due_at=t.due_at,
                category=t.category,
                priority=t.priority,
                # The point is not to forget it: timed tasks always come with a reminder.
                remind_before_minutes=(t.remind_before_minutes or DEFAULT_REMIND_MINUTES) if t.due_at else None,
            )
            for t in fresh
        )

    if copies:
        if len(copies) == 1:
            title, body = f"{_name(me)} added a task for you", f"{copies[0].title} · {when(copies[0], recipient)}"
        else:
            title, body = f"{_name(me)} added {len(copies)} tasks for you", ", ".join(c.title for c in copies[:3])
        _notify(recipient, title, body, url="/", event="tasks")
    return {"mode": "added", "added": len(copies), "already": len(upcoming) - len(fresh), "past": past}


def _members(task):
    """Everyone's copy of the same shared plan: the original plus every linked copy."""
    root = task.linked_from if task.linked_from_id else task
    if root is None:
        return []
    return [root, *Task.objects.filter(linked_from=root).select_related("owner")]


def sync_copies(task, before):
    """Someone (creator or friend) changed their copy of a shared plan: copy the synced fields to
    everyone else's and tell them what changed. `before` holds the values from before the change."""
    changed = [f for f in SYNCED_FIELDS if getattr(task, f) != before[f]]
    if not changed:
        return 0
    others = [m for m in _members(task) if m.pk != task.pk and m.deleted_at is None]
    editor = _name(task.owner)
    for other in others:
        for field in changed:
            setattr(other, field, getattr(task, field))
        update_fields = list(changed)
        if "due_at" in changed:
            other.reminder_sent_at = None  # new time: the reminder fires again
            if other.due_at and not other.remind_before_minutes:
                other.remind_before_minutes = DEFAULT_REMIND_MINUTES
            update_fields += ["reminder_sent_at", "remind_before_minutes"]
        other.save(update_fields=update_fields)
        if "due_at" in changed:
            title, body = f"{editor} moved a task", f"{other.title} is now {when(other, other.owner)}"
        elif "title" in changed:
            title, body = f"{editor} renamed a task", f"{before['title']} is now {other.title}"
        else:
            title, body = f"{editor} updated a task", f"{other.title}: new {', '.join(f for f in changed)}"
        _notify(other.owner, title, body, url="/", event="tasks")
    return len(others)


def cancel_copies(task):
    """A task was deleted. The creator deleting it cancels the plan for everyone (their copies go
    to Recently deleted); a friend deleting theirs only leaves, and the creator is told."""
    if task.linked_from_id:
        root = Task.all_objects.filter(pk=task.linked_from_id).select_related("owner").first()
        if root and root.deleted_at is None:
            _notify(root.owner, f"{_name(task.owner)} left a plan", f"{task.title} was removed from their list.", url="/", event="tasks")
        return 0
    copies = list(Task.objects.filter(linked_from=task).select_related("owner"))
    now = timezone.now()
    for copy in copies:
        copy.deleted_at = now
        copy.save(update_fields=["deleted_at"])
        _notify(copy.owner, f"{_name(task.owner)} cancelled a task", f"{copy.title} was removed from your list.", url="/", event="tasks")
    return len(copies)


def unlink_between(a, b):
    """No longer friends: copies stay where they are but stop following each other."""
    Task.all_objects.filter(owner=a, linked_from__owner=b).update(linked_from=None)
    Task.all_objects.filter(owner=b, linked_from__owner=a).update(linked_from=None)
