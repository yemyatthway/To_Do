from django.conf import settings
from django.db import models
from django.db.models import Q

from .crypto import decrypt, encrypt


class Conversation(models.Model):
    """A 1-to-1 chat between two friends. The pair is stored low id first, so there's only one."""

    user_a = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    user_b = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    last_message_at = models.DateTimeField(null=True, blank=True, db_index=True)
    # When each side last read it (for unread counts and "Seen").
    read_a_at = models.DateTimeField(null=True, blank=True)
    read_b_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user_a", "user_b"], name="one_chat_per_pair"),
            models.CheckConstraint(condition=Q(user_a__lt=models.F("user_b")), name="chat_pair_ordered"),
        ]

    @classmethod
    def involving(cls, user):
        return cls.objects.filter(Q(user_a=user) | Q(user_b=user))

    def other(self, user):
        return self.user_b if self.user_a_id == user.pk else self.user_a

    def read_at(self, user):
        return self.read_a_at if self.user_a_id == user.pk else self.read_b_at

    def set_read(self, user, when):
        field = "read_a_at" if self.user_a_id == user.pk else "read_b_at"
        setattr(self, field, when)
        return field


class Message(models.Model):
    conversation = models.ForeignKey(Conversation, on_delete=models.CASCADE, related_name="messages")
    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    # Encrypted at rest (see crypto.py); use .text to read and write it.
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    # "Delete for everyone": the text is wiped, the row stays so the conversation keeps its shape.
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["conversation", "created_at"])]

    @property
    def text(self):
        return "" if self.deleted_at else decrypt(self.body)

    @text.setter
    def text(self, value):
        self.body = encrypt(value)
