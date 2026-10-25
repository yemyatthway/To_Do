from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.tasks.models import Task


class Friendship(models.Model):
    """One row per pair of people. Pending until the addressee accepts."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"

    requester = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="friend_requests_sent")
    addressee = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="friend_requests_received")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField(auto_now_add=True)
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["requester", "addressee"], name="uniq_friendship_pair"),
            models.CheckConstraint(condition=~Q(requester=models.F("addressee")), name="no_self_friendship"),
        ]

    def other(self, user):
        return self.addressee if self.requester_id == user.id else self.requester

    @classmethod
    def between(cls, a, b):
        return cls.objects.filter(Q(requester=a, addressee=b) | Q(requester=b, addressee=a)).first()

    @classmethod
    def are_friends(cls, a, b):
        return cls.objects.filter(
            Q(requester=a, addressee=b) | Q(requester=b, addressee=a), status=cls.Status.ACCEPTED
        ).exists()


class Share(models.Model):
    """A bundle of task copies sent to a friend. The recipient never sees the sender's real tasks."""

    class Status(models.TextChoices):
        NEW = "new", "New"
        ADDED = "added", "Added"
        DISMISSED = "dismissed", "Dismissed"

    sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="shares_sent")
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="shares_received")
    message = models.CharField(max_length=280, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.NEW)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["recipient", "status"])]


class SharedTask(models.Model):
    """A snapshot of one task at the moment it was sent."""

    share = models.ForeignKey(Share, on_delete=models.CASCADE, related_name="tasks")
    title = models.CharField(max_length=200)
    notes = models.TextField(blank=True)
    due_at = models.DateTimeField(null=True, blank=True)
    category = models.CharField(max_length=20, choices=Task.Category.choices)
    priority = models.CharField(max_length=10, choices=Task.Priority.choices)
    added = models.BooleanField(default=False)

    class Meta:
        ordering = [models.F("due_at").asc(nulls_last=True), "id"]
