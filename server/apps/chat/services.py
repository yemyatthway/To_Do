import re
import threading
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, close_old_connections, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from apps.live import ably
from apps.social.models import Friendship
from apps.social.services import _notify
from apps.users.language import tr
from apps.users.models import User

from .models import Conversation, GroupMember, HiddenMessage, Message, MessageReaction, ScheduledMessage

MAX_LENGTH = 2000
PAGE = 50
EDIT_HOURS = 24  # your own messages can be edited for a day
MAX_SCHEDULED = 50
MAX_SCHEDULE_DAYS = 365
MAX_SCHEDULED_PER_RUN = 100
MAX_GROUP_MEMBERS = 50
MAX_GROUP_NAME = 80
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
    conversation = Conversation.involving(me).select_related("user_a", "user_b").prefetch_related("members__user").filter(pk=conversation_id).first()
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
    if conversation.is_group and (member := conversation.member(me)):
        messages = messages.filter(created_at__gte=member.joined_at)
    return messages


def send(me, conversation, text, client_id=None, reply_to=None):
    """Sending the same client_id again returns the saved message, with no second post or push."""
    if client_id and (existing := conversation.messages.filter(sender=me, client_id=client_id).first()):
        return existing
    text = _clean(text)
    _can_message(me, conversation)
    # Something it answers that's gone (or was never in this chat) just makes it a normal message.
    original = conversation.messages.filter(pk=reply_to, event__isnull=True).first() if type(reply_to) is int else None

    now = timezone.now()
    try:
        with transaction.atomic():
            message = Message(conversation=conversation, sender=me, client_id=client_id, reply_to=original)
            message.text = text
            message.save()
            conversation.last_message_at = message.created_at
            conversation.save(update_fields=["last_message_at"])
            conversation.save_read(me, now)  # your own message counts as read by you
    except IntegrityError:  # the same send arrived twice at once
        if client_id and (existing := conversation.messages.filter(sender=me, client_id=client_id).first()):
            return existing
        raise

    payload = message_data(message, viewer=None)
    ably.to_chat(conversation.pk, "message", payload)
    ably.to_users(conversation.people_ids(), "chat", {"conversation": conversation.pk})
    # Asking Ably who's in the chat takes a moment, so the sender doesn't wait for it.
    if settings.PUSH_SEND_ASYNC:
        threading.Thread(target=_push_in_background, args=(me, conversation, text), daemon=True).start()
    else:
        _push_if_away(me, conversation, text)
    return message


def _push_if_away(me, conversation, text):
    """A push only for those who don't have this chat open right now."""
    here = ably.present(f"chat:{conversation.pk}")
    name = me.full_name or me.email
    words = text if len(text) <= 140 else text[:137] + "…"
    for other in conversation.others(me):
        if str(other.pk) in here:
            continue
        title, body = (conversation.title_for(other), f"{name}: {words}") if conversation.is_group else (name, words)
        _notify(other, title, body, url=f"/?view=chats&chat={conversation.pk}", event="chat")


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
    conversation.save_read(me, now)
    ably.to_chat(conversation.pk, "read", {"user": me.pk, "at": now.isoformat()})
    ably.to_users([me.pk], "chat", {"conversation": conversation.pk})
    return now


def edit_message(me, conversation, message_id, text):
    message = conversation.messages.filter(pk=message_id, sender=me, deleted_at__isnull=True, event__isnull=True).first()
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
        ably.to_users(conversation.people_ids(), "chat", {"conversation": conversation.pk})
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
    conversation.save_cleared(me, timezone.now())
    ably.to_users([me.pk], "chat", {"conversation": conversation.pk, "cleared": True})


def delete_message(me, conversation, message_id):
    message = conversation.messages.filter(pk=message_id, sender=me, deleted_at__isnull=True, event__isnull=True).first()
    if message is None:
        raise NotFound("You can only delete your own messages.")
    message.deleted_at = timezone.now()
    message.text = ""  # the words themselves are gone, not just hidden
    message.save(update_fields=["deleted_at", "body"])
    ably.to_chat(conversation.pk, "deleted", {"id": message.pk})
    ably.to_users(conversation.people_ids(), "chat", {"conversation": conversation.pk})
    return message


def react(me, conversation, message_id, emoji):
    """Your reaction to a message, or none with emoji=None. Tell the other person straight away."""
    if emoji is not None and (len(emoji) > 32 or not ONE_EMOJI.fullmatch(emoji)):
        raise ValidationError({"emoji": ["Choose one emoji."]})
    message = visible(me, conversation).filter(pk=message_id, deleted_at__isnull=True, event__isnull=True).first()
    if message is None:
        raise NotFound("That message doesn't exist.")
    if emoji is None:
        MessageReaction.objects.filter(message=message, user=me).delete()
    else:
        if conversation.is_group:
            _can_message(me, conversation)
        else:
            other = conversation.other(me)
            if not other.is_active or not Friendship.are_friends(me, other):
                raise PermissionDenied("You're no longer friends, so you can't react here.")
        MessageReaction.objects.update_or_create(message=message, user=me, defaults={"emoji": emoji})
    reactions = reactions_of(message)
    ably.to_chat(conversation.pk, "reacted", {"id": message.pk, "reactions": reactions})
    author = message.sender
    if emoji is not None and author.pk != me.pk and str(author.pk) not in ably.present(f"chat:{conversation.pk}"):
        _notify(author, me.full_name or me.email, tr(author, "Reacted {emoji} to your message", emoji=emoji), url=f"/?view=chats&chat={conversation.pk}", event="chat")
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
    messages = visible(me, conversation).exclude(sender=me).filter(deleted_at__isnull=True, event__isnull=True)
    if read_at:
        messages = messages.filter(created_at__gt=read_at)
    return messages.count()


def total_unread(me):
    return sum(unread_count(me, c) for c in Conversation.involving(me).filter(last_message_at__isnull=False).prefetch_related("members"))


def message_data(message, viewer):
    return {
        "id": message.pk,
        "client_id": str(message.client_id) if message.client_id else None,
        "conversation": message.conversation_id,
        "sender": message.sender_id,
        "sender_name": message.sender.full_name or f"@{message.sender.username}",
        "event": message.event,
        "mine": viewer is not None and message.sender_id == viewer.pk,
        "text": message.text,
        "deleted": message.deleted_at is not None,
        "edited": message.edited_at is not None and message.deleted_at is None,
        "reply": reply_data(message),
        "reactions": [] if message.deleted_at else reactions_of(message),
        "created_at": message.created_at.isoformat(),
    }


# --- groups ---------------------------------------------------------------------------------

def _person_name(user):
    return user.full_name or f"@{user.username}"


def _clean_group_name(name):
    if name is not None and not isinstance(name, str):
        raise ValidationError({"name": ["That isn't valid."]})
    name = " ".join((name or "").split())
    if len(name) > MAX_GROUP_NAME:
        raise ValidationError({"name": [f"Keep the name under {MAX_GROUP_NAME} characters."]})
    return name


def _my_friends(me, ids):
    """The people asked for, all of whom have to be your friends. You can't add a stranger."""
    if not isinstance(ids, list) or not all(type(i) is int for i in ids):
        raise ValidationError({"members": ["That list isn't valid."]})
    people = list(User.objects.filter(pk__in=set(ids) - {me.pk}, is_active=True))
    if len(people) != len(set(ids) - {me.pk}) or not all(Friendship.are_friends(me, person) for person in people):
        raise PermissionDenied("You can only add your friends.")
    return people


def _post_event(me, conversation, kind, name=""):
    """A line about the group, shown to everyone in it."""
    message = Message.objects.create(conversation=conversation, sender=me, body="", event={"type": kind, "name": name})
    Conversation.objects.filter(pk=conversation.pk).update(last_message_at=message.created_at)
    ably.to_chat(conversation.pk, "message", message_data(message, viewer=None))
    return message


def _members_changed(conversation, also=()):
    """Open chats redraw, and lists catch up, for everyone involved (including anyone just removed)."""
    ably.to_chat(conversation.pk, "members")
    ably.to_users(list(GroupMember.objects.filter(conversation=conversation).values_list("user_id", flat=True)) + list(also), "chat", {"conversation": conversation.pk})


def _group_for_admin(me, conversation):
    member = conversation.member(me) if conversation.is_group else None
    if member is None:
        raise NotFound("That chat doesn't exist.")
    if not member.is_admin:
        raise PermissionDenied("Only a group admin can do that.")


def create_group(me, name, member_ids):
    name = _clean_group_name(name)
    people = _my_friends(me, member_ids)
    if not people:
        raise ValidationError({"members": ["Add at least one friend."]})
    if len(people) + 1 > MAX_GROUP_MEMBERS:
        raise ValidationError({"members": [f"A group can have up to {MAX_GROUP_MEMBERS} people."]})
    with transaction.atomic():
        conversation = Conversation.objects.create(is_group=True, name=name)
        GroupMember.objects.create(conversation=conversation, user=me, is_admin=True, read_at=timezone.now())
        GroupMember.objects.bulk_create(GroupMember(conversation=conversation, user=person) for person in people)
    _post_event(me, conversation, "created")
    conversation = conversation_for(me, conversation.pk)
    _members_changed(conversation)
    for person in people:
        _notify(person, conversation.title_for(person), tr(person, "{name} added you to this group", name=_person_name(me)), url=f"/?view=chats&chat={conversation.pk}", event="chat")
    return conversation


def rename_group(me, conversation, name):
    _group_for_admin(me, conversation)
    name = _clean_group_name(name)
    if name != conversation.name:
        conversation.name = name
        conversation.save(update_fields=["name"])
        _post_event(me, conversation, "renamed", name)
        _members_changed(conversation)
    return conversation


def add_members(me, conversation, member_ids):
    _group_for_admin(me, conversation)
    people = [person for person in _my_friends(me, member_ids) if conversation.member(person) is None]
    if conversation.members.count() + len(people) > MAX_GROUP_MEMBERS:
        raise ValidationError({"members": [f"A group can have up to {MAX_GROUP_MEMBERS} people."]})
    for person in people:
        GroupMember.objects.create(conversation=conversation, user=person)
        _post_event(me, conversation, "added", _person_name(person))
    conversation = conversation_for(me, conversation.pk)
    if people:
        _members_changed(conversation)
    for person in people:
        _notify(person, conversation.title_for(person), tr(person, "{name} added you to this group", name=_person_name(me)), url=f"/?view=chats&chat={conversation.pk}", event="chat")
    return conversation


def keep_an_admin(conversation):
    """Whoever's been in longest takes over if no admin with a working account is left."""
    active = conversation.members.filter(user__is_active=True).order_by("joined_at", "id")
    first = active.first()
    if first and not active.filter(is_admin=True).exists():
        GroupMember.objects.filter(pk=first.pk).update(is_admin=True)


def settle_group_admins(user):
    """Someone's account was deleted or restored: every group they're in still needs an admin."""
    for member in GroupMember.objects.filter(user=user).select_related("conversation"):
        keep_an_admin(member.conversation)


def remove_member(me, conversation, user_id):
    """Take someone out (admins), or leave yourself. The last person out ends the group. If the last
    admin goes, whoever's been in longest takes over, so a group is never left without one."""
    if not conversation.is_group or conversation.member(me) is None:
        raise NotFound("That chat doesn't exist.")
    leaving = user_id == me.pk
    if not leaving:
        _group_for_admin(me, conversation)
    member = conversation.members.filter(user_id=user_id).select_related("user").first()
    if member is None:
        raise NotFound("They aren't in this group.")
    name = _person_name(member.user)
    with transaction.atomic():
        member.delete()
        conversation.scheduled.filter(sender_id=user_id).delete()
        left = conversation.members.order_by("joined_at", "id")
        if not left.exists():
            conversation.delete()
            return None
        keep_an_admin(conversation)
    _post_event(me, conversation, "left" if leaving else "removed", name)
    _members_changed(conversation, also=[user_id])
    return conversation


def _clean_send_at(value, now=None):
    now = now or timezone.now()
    try:
        when = parse_datetime(value) if isinstance(value, str) else None
    except ValueError:
        when = None
    if when is None or when.tzinfo is None:
        raise ValidationError({"send_at": ["Choose a date and time."]})
    if when <= now:
        raise ValidationError({"send_at": ["Choose a time in the future."]})
    if when > now + timedelta(days=MAX_SCHEDULE_DAYS):
        raise ValidationError({"send_at": ["You can schedule up to a year ahead."]})
    return when


def _can_message(me, conversation):
    if conversation.is_group:
        if not conversation.members.filter(user=me).exists():
            raise PermissionDenied("You're no longer in this group.")
        return
    other = conversation.other(me)
    if not other.is_active or not Friendship.are_friends(me, other):
        raise PermissionDenied("You're no longer friends, so you can't send messages here.")


def schedule(me, conversation, text, send_at):
    text = _clean(text)
    when = _clean_send_at(send_at)
    _can_message(me, conversation)
    if ScheduledMessage.objects.filter(sender=me).count() >= MAX_SCHEDULED:
        raise ValidationError({"send_at": [f"You can have up to {MAX_SCHEDULED} scheduled messages."]})
    item = ScheduledMessage(conversation=conversation, sender=me, send_at=when)
    item.text = text
    item.save()
    return item


def scheduled_of(me, conversation):
    return conversation.scheduled.filter(sender=me)


def _scheduled_for(me, conversation, item_id):
    item = scheduled_of(me, conversation).filter(pk=item_id).exclude(status=ScheduledMessage.Status.SENDING).first()
    if item is None:
        raise NotFound("That scheduled message doesn't exist.")
    return item


def update_scheduled(me, conversation, item_id, text=None, send_at=None):
    item = _scheduled_for(me, conversation, item_id)
    if text is not None:
        item.text = _clean(text)
    if send_at is not None:
        item.send_at = _clean_send_at(send_at)
    elif item.status == ScheduledMessage.Status.FAILED and item.send_at <= timezone.now():
        raise ValidationError({"send_at": ["Choose a time in the future."]})
    item.status = ScheduledMessage.Status.PENDING
    item.error = ""
    item.save()
    return item


def delete_scheduled(me, conversation, item_id):
    _scheduled_for(me, conversation, item_id).delete()


def send_scheduled_now(me, conversation, item_id):
    item = _scheduled_for(me, conversation, item_id)
    message = send(me, conversation, item.text, client_id=item.client_id)
    item.delete()
    return message


def _deliver_scheduled(item, now):
    sender, conversation = item.sender, item.conversation
    try:
        send(sender, conversation, item.text, client_id=item.client_id)
    except (PermissionDenied, ValidationError) as error:
        reason = error.detail if isinstance(error.detail, str) else "This message can't be sent."
        reason = tr(sender, str(reason))
        ScheduledMessage.objects.filter(pk=item.pk).update(status=ScheduledMessage.Status.FAILED, error=str(reason)[:200], claimed_at=None)
        _notify(sender, tr(sender, "A scheduled message wasn't sent"), reason, url=f"/?view=chats&chat={conversation.pk}", event="chat")
        return False
    item.delete()
    return True


def send_due_scheduled(now=None):
    """Runs from the every-minute job. Returns how many messages went out."""
    now = now or timezone.now()
    # A run that died part way: try again. The client_id means nothing posts twice.
    ScheduledMessage.objects.filter(status=ScheduledMessage.Status.SENDING, claimed_at__lt=now - timedelta(minutes=5)).update(status=ScheduledMessage.Status.PENDING)
    due = ScheduledMessage.objects.filter(status=ScheduledMessage.Status.PENDING, send_at__lte=now).select_related("sender", "conversation__user_a", "conversation__user_b").order_by("send_at")[:MAX_SCHEDULED_PER_RUN]
    sent = 0
    for item in due:
        # Claimed first, so two runs at once can't both send it.
        if ScheduledMessage.objects.filter(pk=item.pk, status=ScheduledMessage.Status.PENDING).update(status=ScheduledMessage.Status.SENDING, claimed_at=now):
            sent += _deliver_scheduled(item, now)
    return sent
