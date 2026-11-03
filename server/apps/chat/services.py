import re
import threading
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, close_old_connections, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from apps.live import ably
from apps.social.models import Friendship
from apps.social.services import _notify
from apps.users.models import User

from .models import Conversation, HiddenMessage, Message, MessageReaction

MAX_LENGTH = 2000
PAGE = 50
EDIT_HOURS = 24  # your own messages can be edited for a day
# One emoji as a keyboard types it, with any skin tone, joined people, flag or keycap. Nothing else.
_PICTURE = (
    r"[\u00a9\u00ae\u203c\u2049\u2122\u2139\u2194-\u21aa\u231a-\u23ff\u24c2\u25aa-\u25fe\u2600-\u27bf"
    r"\u2934\u2935\u2b05-\u2b55\u3030\u303d\u3297\u3299\U0001f000-\U0001f1e5\U0001f200-\U0001faff]"
    r"[\ufe0f\U0001f3fb-\U0001f3ff]?[\U000e0020-\U000e007f]*"
)
ONE_EMOJI = re.compile(rf"[\U0001f1e6-\U0001f1ff]{{2}}|[0-9#*]\ufe0f?\u20e3|{_PICTURE}(?:\u200d{_PICTURE})*")


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


def _clean(text):
    text = (text or "").strip()
    if not text:
        raise ValidationError({"text": ["Write a message first."]})
    if len(text) > MAX_LENGTH:
        raise ValidationError({"text": [f"Keep it under {MAX_LENGTH} characters."]})
    return text


def visible(me, conversation):
    """The messages this person sees: not ones they deleted for themselves or cleared."""
    messages = conversation.messages.exclude(hidden_for__user=me)
    if cleared := conversation.cleared_at(me):
        messages = messages.filter(created_at__gt=cleared)
    return messages


def send(me, conversation, text, client_id=None, reply_to=None):
    """Sending the same client_id again returns the saved message, with no second post or push."""
    if client_id and (existing := conversation.messages.filter(sender=me, client_id=client_id).first()):
        return existing
    text = _clean(text)
    other = conversation.other(me)
    if not other.is_active or not Friendship.are_friends(me, other):
        raise PermissionDenied("You're no longer friends, so you can't send messages here.")
    # Something it answers that's gone (or was never in this chat) just makes it a normal message.
    original = conversation.messages.filter(pk=reply_to).first() if type(reply_to) is int else None

    now = timezone.now()
    try:
        with transaction.atomic():
            message = Message(conversation=conversation, sender=me, client_id=client_id, reply_to=original)
            message.text = text
            message.save()
            conversation.last_message_at = message.created_at
            field = conversation.set_read(me, now)  # your own message counts as read by you
            conversation.save(update_fields=["last_message_at", field])
    except IntegrityError:  # the same send arrived twice at once
        if client_id and (existing := conversation.messages.filter(sender=me, client_id=client_id).first()):
            return existing
        raise

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
    messages = visible(me, conversation).select_related("sender", "reply_to").prefetch_related("reactions")
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


def edit_message(me, conversation, message_id, text):
    message = conversation.messages.filter(pk=message_id, sender=me, deleted_at__isnull=True).first()
    if message is None:
        raise NotFound("You can only edit your own messages.")
    if timezone.now() - message.created_at > timedelta(hours=EDIT_HOURS):
        raise ValidationError({"text": [f"Messages can only be edited for {EDIT_HOURS} hours."]})
    text = _clean(text)
    if text != message.text:
        message.text = text
        message.edited_at = timezone.now()
        message.save(update_fields=["body", "edited_at"])
        ably.to_chat(conversation.pk, "edited", message_data(message, viewer=None))
        ably.to_users([conversation.user_a_id, conversation.user_b_id], "chat", {"conversation": conversation.pk})
    return message


def hide_message(me, conversation, message_id):
    """Delete for me: any message in the chat, only on my side."""
    message = conversation.messages.filter(pk=message_id).first()
    if message is None:
        raise NotFound("That message doesn't exist.")
    HiddenMessage.objects.get_or_create(message=message, user=me)
    ably.to_users([me.pk], "chat", {"conversation": conversation.pk, "hidden": message.pk})


def clear_chat(me, conversation):
    """Empties the chat on my side only; new messages show up as usual."""
    field = conversation.set_cleared(me, timezone.now())
    conversation.save(update_fields=[field])
    ably.to_users([me.pk], "chat", {"conversation": conversation.pk, "cleared": True})


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


def react(me, conversation, message_id, emoji):
    """Your reaction to a message, or none with emoji=None. Tell the other person straight away."""
    if emoji is not None and (len(emoji) > 32 or not ONE_EMOJI.fullmatch(emoji)):
        raise ValidationError({"emoji": ["Choose one emoji."]})
    message = visible(me, conversation).filter(pk=message_id, deleted_at__isnull=True).first()
    if message is None:
        raise NotFound("That message doesn't exist.")
    other = conversation.other(me)
    if emoji is None:
        MessageReaction.objects.filter(message=message, user=me).delete()
    else:
        if not other.is_active or not Friendship.are_friends(me, other):
            raise PermissionDenied("You're no longer friends, so you can't react here.")
        MessageReaction.objects.update_or_create(message=message, user=me, defaults={"emoji": emoji})
    reactions = reactions_of(message)
    ably.to_chat(conversation.pk, "reacted", {"id": message.pk, "reactions": reactions})
    if emoji is not None and message.sender_id == other.pk and str(other.pk) not in ably.present(f"chat:{conversation.pk}"):
        _notify(other, me.full_name or me.email, f"Reacted {emoji} to your message", url=f"/?view=chats&chat={conversation.pk}", event="chat")
    return reactions


def reactions_of(message):
    return [{"user": r.user_id, "emoji": r.emoji} for r in message.reactions.all()]


def reply_data(message):
    original = message.reply_to
    if original is None:
        return None
    return {"id": original.pk, "sender": original.sender_id, "text": original.text[:200], "deleted": original.deleted_at is not None}


def unread_count(me, conversation):
    read_at = conversation.read_at(me)
    messages = visible(me, conversation).exclude(sender=me).filter(deleted_at__isnull=True)
    if read_at:
        messages = messages.filter(created_at__gt=read_at)
    return messages.count()


def total_unread(me):
    return sum(unread_count(me, c) for c in Conversation.involving(me).filter(last_message_at__isnull=False))


def message_data(message, viewer):
    return {
        "id": message.pk,
        "client_id": str(message.client_id) if message.client_id else None,
        "conversation": message.conversation_id,
        "sender": message.sender_id,
        "mine": viewer is not None and message.sender_id == viewer.pk,
        "text": message.text,
        "deleted": message.deleted_at is not None,
        "edited": message.edited_at is not None and message.deleted_at is None,
        "reply": reply_data(message),
        "reactions": [] if message.deleted_at else reactions_of(message),
        "created_at": message.created_at.isoformat(),
    }
