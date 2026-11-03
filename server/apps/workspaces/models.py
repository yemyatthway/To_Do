from django.conf import settings
from django.db import models
from django.db.models import Q

from . import permissions


class LiveWorkspaceManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class Workspace(models.Model):
    name = models.CharField(max_length=80)
    created_at = models.DateTimeField(auto_now_add=True)
    # Soft delete, like accounts and tasks: erased for good by the daily clean-up.
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = LiveWorkspaceManager()
    all_objects = models.Manager()

    class Meta:
        base_manager_name = "all_objects"

    def __str__(self):
        return self.name


class Membership(models.Model):
    ROLES = [(role, role.capitalize()) for role in reversed(permissions.ROLE_ORDER)]

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="workspace_memberships")
    role = models.CharField(max_length=10, choices=ROLES)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "user"], name="one_membership_per_person"),
            # Every workspace has exactly one owner; the database itself refuses a second.
            models.UniqueConstraint(fields=["workspace"], condition=Q(role=permissions.OWNER), name="one_owner_per_workspace"),
        ]


class Invitation(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        DECLINED = "declined", "Declined"
        CANCELLED = "cancelled", "Cancelled"

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="invitations")
    # Always an email, even when invited by @username: only that verified address can accept.
    email = models.EmailField(max_length=160, db_index=True)
    # What the inviter typed, shown in their list. Never reveals an address they didn't already know.
    label = models.CharField(max_length=160)
    role = models.CharField(max_length=10, choices=Membership.ROLES)
    invited_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "email"], condition=Q(status="pending"), name="one_pending_invite_per_email"),
        ]
