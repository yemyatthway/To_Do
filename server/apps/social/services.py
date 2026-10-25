import logging
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from pywebpush import WebPushException
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from apps.notifications.push import send_push
from apps.tasks.models import Task
from apps.tasks.serializers import user_zone
from apps.users.models import User

from .models import Friendship, Share, SharedTask

logger = logging.getLogger(__name__)
MAX_TASKS_PER_SHARE = 50


def mask_email(email):
    """m•••@gmail.com: enough to recognise someone, not enough to harvest addresses."""
    local, _, domain = email.partition("@")
    return f"{local[:1]}•••@{domain}"


def search_users(*, me, query, limit=20):
    """Name contains the query, or the email matches exactly. Never lists yourself or banned accounts."""
    query = query.strip()
    if len(query) < 2:
        return []
    return list(
        User.objects.filter(is_active=True)
        .exclude(pk=me.pk)
        .filter(Q(full_name__icontains=query) | Q(email__iexact=query))
        .order_by("full_name", "email")[:limit]
    )


def relationship(me, friendship):
    """none | friends | outgoing | incoming, plus the friendship id when there is one."""
    if friendship is None:
        return "none", None
    if friendship.status == Friendship.Status.ACCEPTED:
        return "friends", friendship.pk
    return ("outgoing" if friendship.requester_id == me.pk else "incoming"), friendship.pk


def friendships_by_other(me):
    # People who are banned or deleted their account drop out of lists (and come back if restored).
    rows = Friendship.objects.filter(Q(requester=me) | Q(addressee=me)).filter(requester__is_active=True, addressee__is_active=True)
    return {(f.addressee_id if f.requester_id == me.pk else f.requester_id): f for f in rows}


def send_request(*, me, user_id):
    other = User.objects.filter(pk=user_id, is_active=True).first()
    if other is None or other.pk == me.pk:
        raise NotFound("That person couldn't be found.")
    existing = Friendship.between(me, other)
    if existing:
        # They already asked you: sending back simply accepts.
        if existing.status == Friendship.Status.PENDING and existing.addressee_id == me.pk:
            return accept_request(me=me, friendship_id=existing.pk)
        return existing
    friendship = Friendship.objects.create(requester=me, addressee=other)
    _notify(other, "New friend request", f"{me.full_name or me.email} wants to be friends.", url="/?view=friends")
    return friendship


def accept_request(*, me, friendship_id):
    friendship = Friendship.objects.filter(pk=friendship_id, addressee=me, status=Friendship.Status.PENDING).first()
    if friendship is None:
        raise NotFound("That request is no longer pending.")
    friendship.status = Friendship.Status.ACCEPTED
    friendship.responded_at = timezone.now()
    friendship.save(update_fields=["status", "responded_at"])
    return friendship


def remove_friendship(*, me, friendship_id):
    """Decline an incoming request, cancel an outgoing one, or unfriend."""
    deleted, _ = Friendship.objects.filter(Q(requester=me) | Q(addressee=me), pk=friendship_id).delete()
    if not deleted:
        raise NotFound("That friendship doesn't exist.")


def share_tasks(*, me, recipient_id, task_ids, message=""):
    recipient = User.objects.filter(pk=recipient_id, is_active=True).first()
    if recipient is None or not Friendship.are_friends(me, recipient):
        raise PermissionDenied("You can only send tasks to friends.")
    task_ids = list(dict.fromkeys(task_ids))[:MAX_TASKS_PER_SHARE]
    tasks = list(Task.objects.filter(owner=me, pk__in=task_ids))
    if not tasks:
        raise ValidationError({"task_ids": ["Pick at least one of your tasks."]})
    with transaction.atomic():
        share = Share.objects.create(sender=me, recipient=recipient, message=message.strip()[:280])
        SharedTask.objects.bulk_create(
            SharedTask(share=share, title=t.title, notes=t.notes, due_at=t.due_at, category=t.category, priority=t.priority)
            for t in tasks
        )
    count = len(tasks)
    _notify(
        recipient,
        f"{me.full_name or me.email} sent you {count} task{'s' if count != 1 else ''}",
        message.strip() or ", ".join(t.title for t in tasks[:3]),
        url="/?view=friends",
    )
    return share


def add_shared(*, me, share_id, item_ids=None):
    """Copy shared tasks into my list. Same-time clashes are allowed and reported back."""
    share = Share.objects.filter(pk=share_id, recipient=me).prefetch_related("tasks").first()
    if share is None:
        raise NotFound("That share couldn't be found.")
    items = [i for i in share.tasks.all() if not i.added and (item_ids is None or i.pk in item_ids)]
    zone = user_zone(me)
    today = timezone.localtime(timezone.now(), zone).date()

    created, moved, clashes = [], [], []
    with transaction.atomic():
        for item in items:
            due_at = item.due_at
            # A day that's already over for me can't hold a task: keep it, but under Anytime.
            if due_at and timezone.localtime(due_at, zone).date() < today:
                moved.append(item.title)
                due_at = None
            if due_at:
                window = (due_at - timedelta(seconds=59), due_at + timedelta(seconds=59))
                for existing in Task.objects.filter(owner=me, due_at__range=window):
                    clashes.append({"new": item.title, "existing": existing.title, "due_at": due_at})
            created.append(
                Task.objects.create(
                    owner=me,
                    title=item.title,
                    notes=item.notes,
                    due_at=due_at,
                    category=item.category,
                    priority=item.priority,
                    remind_before_minutes=10 if due_at else None,
                )
            )
            item.added = True
            item.save(update_fields=["added"])
        if all(i.added for i in share.tasks.all()):
            share.status = Share.Status.ADDED
            share.save(update_fields=["status"])
    return share, created, moved, clashes


def dismiss_share(*, me, share_id):
    updated = Share.objects.filter(pk=share_id, recipient=me).update(status=Share.Status.DISMISSED)
    if not updated:
        raise NotFound("That share couldn't be found.")


def _notify(user, title, body, url="/"):
    """Best-effort push to someone who has reminders on; sharing works the same without it."""
    if not user.reminders_enabled:
        return
    for subscription in user.push_subscriptions.all():
        try:
            send_push(subscription, title, body, url=url)
        except WebPushException as exc:
            logger.warning("Social push to %s failed: %s", subscription, exc)
