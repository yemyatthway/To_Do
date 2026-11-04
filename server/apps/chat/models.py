import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q

from .crypto import decrypt, encrypt


class Conversation(models.Model):
    """A 1-to-1 chat between two friends, or a group. A pair is stored low id first, so there's only
    one; a group has no pair and keeps its people, and what each has read, in GroupMember."""

    user_a = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    user_b = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    is_group = models.BooleanField(default=False)
    # Empty: it's called after the people in it.
    name = models.CharField(max_length=80, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_message_at = models.DateTimeField(null=True, blank=True, db_index=True)
    # When each side last read it (for unread counts and "Seen").
    read_a_at = models.DateTimeField(null=True, blank=True)
    read_b_at = models.DateTimeField(null=True, blank=True)
    # "Clear chat" (just for that side): messages up to then are hidden for them.
    cleared_a_at = models.DateTimeField(null=True, blank=True)
    cleared_b_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user_a", "user_b"], name="one_chat_per_pair"),
            models.CheckConstraint(condition=Q(user_a__lt=models.F("user_b")), name="chat_pair_ordered"),
            models.CheckConstraint(
                condition=Q(is_group=True, user_a__isnull=True, user_b__isnull=True) | Q(is_group=False, user_a__isnull=False, user_b__isnull=False),
                name="chat_pair_or_group",
            ),
        ]

    @classmethod
    def involving(cls, user):
        return cls.objects.filter(Q(user_a=user) | Q(user_b=user) | Q(members__user=user))

    def other(self, user):
        return self.user_b if self.user_a_id == user.pk else self.user_a

    def member(self, user):
        return next((m for m in self.members.all() if m.user_id == user.pk), None)

    def others(self, user):
        """Everyone else in this chat."""
        if self.is_group:
            return [m.user for m in self.members.all() if m.user_id != user.pk and m.user.is_active]
        return [self.other(user)]

    def people_ids(self):
        return [m.user_id for m in self.members.all()] if self.is_group else [self.user_a_id, self.user_b_id]

    def read_at(self, user):
        if self.is_group:
            member = self.member(user)
            return member.read_at if member else None
        return self.read_a_at if self.user_a_id == user.pk else self.read_b_at

    def save_read(self, user, when):
        if self.is_group:
            self.members.filter(user=user).update(read_at=when)
            self.__dict__.get("_prefetched_objects_cache", {}).pop("members", None)
            return
        field = "read_a_at" if self.user_a_id == user.pk else "read_b_at"
        setattr(self, field, when)
        self.save(update_fields=[field])

    def cleared_at(self, user):
        if self.is_group:
            member = self.member(user)
            return member.cleared_at if member else None
        return self.cleared_a_at if self.user_a_id == user.pk else self.cleared_b_at

    def save_cleared(self, user, when):
        if self.is_group:
            self.members.filter(user=user).update(cleared_at=when)
            self.__dict__.get("_prefetched_objects_cache", {}).pop("members", None)
            return
        field = "cleared_a_at" if self.user_a_id == user.pk else "cleared_b_at"
        setattr(self, field, when)
        self.save(update_fields=[field])

    def title_for(self, user):
        """A group's name, or the first names of the people in it."""
        if self.name:
            return self.name
        names = [(person.full_name or f"@{person.username}").split()[0] for person in self.others(user)]
        return ", ".join(names[:3]) + (f" +{len(names) - 3}" if len(names) > 3 else "")


class GroupMember(models.Model):
    """One person in a group chat. They see messages from when they joined onwards."""

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="chat_groups")
    is_admin = models.BooleanField(default=False)
    joined_at = models.DateTimeField(auto_now_add=True)
    read_at = models.DateTimeField(null=True, blank=True)
    cleared_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["joined_at", "id"]
        constraints = [models.UniqueConstraint(fields=["conversation", "user"], name="one_group_membership")]


class Message(models.Model):
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    # Encrypted at rest (see crypto.py); use .text to read and write it.
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    # "Delete for everyone": the text is wiped, the row stays so the conversation keeps its shape.
    deleted_at = models.DateTimeField(null=True, blank=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    # Chosen by the app, so sending a message again can't post it twice.
    client_id = models.UUIDField(null=True, blank=True, editable=False)
    # The message this one answers. The reply stays if that one is ever erased.
    reply_to = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="replies")
    # A line about the group itself ("Mia added Aung") instead of words: {type, name}. The app writes
    # it in the reader's language; names stay as they were then.
    event = models.JSONField(null=True, blank=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["conversation", "created_at"])]
        constraints = [
            models.UniqueConstraint(fields=["sender", "client_id"], condition=Q(client_id__isnull=False), name="one_message_per_client_id"),
        ]

    @property
    def text(self):
        return "" if self.deleted_at or self.event else decrypt(self.body)

    @text.setter
    def text(self, value):
        self.body = encrypt(value)


class HiddenMessage(models.Model):
    """"Delete for me": this message no longer shows for this person (the other side keeps it)."""

    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name="hidden_for")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["message", "user"], name="hide_message_once")]


class MessageReaction(models.Model):
    """One person's reaction to a message. Reacting again swaps it."""

    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name="reactions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    emoji = models.CharField(max_length=32)  # a family or flag takes several characters
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["message", "user"], name="one_reaction_per_person")]


class ScheduledMessage(models.Model):
    """A message waiting for its time. The every-minute job sends it as a normal message, then removes this."""

    class Status(models.TextChoices):
        PENDING = "pending"
        SENDING = "sending"
        FAILED = "failed"

    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="scheduled")
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    # Encrypted like every other message.
    body = models.TextField()
    send_at = models.DateTimeField(db_index=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING, db_index=True)
    error = models.CharField(max_length=200, blank=True)
    # So trying again after a crash can't post it twice.
    client_id = models.UUIDField(default=uuid.uuid4, editable=False)
    claimed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["send_at", "id"]

    @property
    def text(self):
        return decrypt(self.body)

    @text.setter
    def text(self, value):
        self.body = encrypt(value)
