import threading

from django.conf import settings
from django.db import close_old_connections, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from apps.live import ably
from apps.social.models import Friendship
from apps.social.services import _notify
from apps.users.models import User

from .models import Conversation, Message

MAX_LENGTH = 2000
PAGE = 50


def _pair(a, b):
    return (a, b) if a.pk < b.pk else (b, a)


def conversation_for(me, conversation_id):
    conversation = Conversation.involving(me).select_related("user_a", "user_b").filter(pk=conversation_id).first()
    if conversation is None:
        raise NotFound("That chat doesn't exist.")
    return conversation


def open_with(me, user_id):
    """The chat with this friend, created the first time."""
    other = User.objects.filter(pk=user_id, is_active=True).first()
    if other is None or other.pk == me.pk or not Friendship.are_friends(me, other):
        raise PermissionDenied("You can only chat with friends.")
    a, b = _pair(me, other)
    conversation, _ = Conversation.objects.get_or_create(user_a=a, user_b=b)
    return conversation


def send(me, conversation, text):
    text = (text or "").strip()
    if not text:
        raise ValidationError({"text": ["Write a message first."]})
    if len(text) > MAX_LENGTH:
        raise ValidationError({"text": [f"Keep it under {MAX_LENGTH} characters."]})
    other = conversation.other(me)
    if not other.is_active or not Friendship.are_friends(me, other):
        raise PermissionDenied("You're no longer friends, so you can't send messages here.")

    now = timezone.now()
    with transaction.atomic():
        message = Message(conversation=conversation, sender=me)
        message.text = text
        message.save()
        conversation.last_message_at = message.created_at
        field = conversation.set_read(me, now)  # your own message counts as read by you
        conversation.save(update_fields=["last_message_at", field])

    payload = message_data(message, viewer=None)
    ably.to_chat(conversation.pk, "message", payload)
    ably.to_users([other.pk, me.pk], "chat", {"conversation": conversation.pk})
    # Asking Ably who's in the chat takes a moment, so the sender doesn't wait for it.
    if settings.PUSH_SEND_ASYNC:
        threading.Thread(target=_push_in_background, args=(me, other, conversation, text), daemon=True).start()
    else:
        _push_if_away(me, other, conversation, text)
    return message


def _push_if_away(me, other, conversation, text):
    """A push only when they don't have this chat open right now."""
    if str(other.pk) in ably.present(f"chat:{conversation.pk}"):
        return
    name = me.full_name or me.email
    _notify(other, name, text if len(text) <= 140 else text[:137] + "…", url=f"/?view=chats&chat={conversation.pk}", event="chat")


def _push_in_background(*args):
    try:
        _push_if_away(*args)
    finally:
        close_old_connections()  # only the worker thread gives back its DB connection


def history(me, conversation, before=None):
    messages = conversation.messages.select_related("sender")
    if before:
        messages = messages.filter(pk__lt=before)
    page = list(messages.order_by("-created_at", "-id")[:PAGE])
    page.reverse()
    return page


def mark_read(me, conversation):
    now = timezone.now()
    field = conversation.set_read(me, now)
    conversation.save(update_fields=[field])
    ably.to_chat(conversation.pk, "read", {"user": me.pk, "at": now.isoformat()})
    ably.to_users([me.pk], "chat", {"conversation": conversation.pk})
    return now


def delete_message(me, conversation, message_id):
    message = conversation.messages.filter(pk=message_id, sender=me, deleted_at__isnull=True).first()
    if message is None:
        raise NotFound("You can only delete your own messages.")
    message.deleted_at = timezone.now()
    message.text = ""  # the words themselves are gone, not just hidden
    message.save(update_fields=["deleted_at", "body"])
    ably.to_chat(conversation.pk, "deleted", {"id": message.pk})
    ably.to_users([conversation.user_a_id, conversation.user_b_id], "chat", {"conversation": conversation.pk})
    return message


def unread_count(me, conversation):
    read_at = conversation.read_at(me)
    messages = conversation.messages.exclude(sender=me).filter(deleted_at__isnull=True)
    if read_at:
        messages = messages.filter(created_at__gt=read_at)
    return messages.count()


def total_unread(me):
    return sum(unread_count(me, c) for c in Conversation.involving(me).filter(last_message_at__isnull=False))


def message_data(message, viewer):
    return {
        "id": message.pk,
        "conversation": message.conversation_id,
        "sender": message.sender_id,
        "mine": viewer is not None and message.sender_id == viewer.pk,
        "text": message.text,
        "deleted": message.deleted_at is not None,
        "created_at": message.created_at.isoformat(),
    }
