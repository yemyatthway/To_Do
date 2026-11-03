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


class LivePageManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class Page(models.Model):
    """A page of writing the team named itself: a list of text, heading and checklist blocks."""

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="pages")
    title = models.CharField(max_length=120)
    # [{"id": "...", "type": "p" | "h" | "todo", "text": "...", "done": bool (todo only)}]
    blocks = models.JSONField(default=list)
    # Goes up with every save, so an edit from an old copy can't overwrite a newer one.
    version = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # Soft delete: can be restored until the daily clean-up erases it.
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = LivePageManager()
    all_objects = models.Manager()

    class Meta:
        base_manager_name = "all_objects"
        indexes = [models.Index(fields=["workspace", "-updated_at"])]

    def __str__(self):
        return self.title


class LiveTableManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class Table(models.Model):
    """A table the team set up itself: its own name and columns, like a bug list or a test plan."""

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="tables")
    title = models.CharField(max_length=120)
    description = models.CharField(max_length=500, blank=True)
    # [{"id": "c1a2b3c4", "name": "Assigned", "type": "text" | "number" | "select" | "person" | "date" | "checkbox"}]
    columns = models.JSONField(default=list)
    next_no = models.PositiveIntegerField(default=1)
    # Goes up with any change to the table or its rows, so open screens can ask "anything new?" cheaply.
    version = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = LiveTableManager()
    all_objects = models.Manager()

    class Meta:
        base_manager_name = "all_objects"
        indexes = [models.Index(fields=["workspace", "-updated_at"])]

    def __str__(self):
        return self.title


class TableRow(models.Model):
    table = models.ForeignKey(Table, on_delete=models.CASCADE, related_name="rows")
    # The row's number in its table. Never reused, so "bug 12" keeps meaning the same bug.
    no = models.PositiveIntegerField()
    # {column id: value}
    values = models.JSONField(default=dict)
    highlighted = models.BooleanField(default=False)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = LiveTableManager()
    all_objects = models.Manager()

    class Meta:
        base_manager_name = "all_objects"
        ordering = ["no"]
        constraints = [models.UniqueConstraint(fields=["table", "no"], name="one_row_per_number")]


class LiveCommentManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class Comment(models.Model):
    """A comment on a page or a table row. Always exactly one of the two."""

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="comments")
    page = models.ForeignKey(Page, null=True, blank=True, on_delete=models.CASCADE, related_name="comments")
    row = models.ForeignKey(TableRow, null=True, blank=True, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = LiveCommentManager()
    all_objects = models.Manager()

    class Meta:
        base_manager_name = "all_objects"
        ordering = ["created_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=(Q(page__isnull=False, row__isnull=True) | Q(page__isnull=True, row__isnull=False)),
                name="comment_on_one_thing",
            ),
        ]


class ActivityEvent(models.Model):
    """One line of a workspace's history. Names are kept as they were, so history stays readable
    after something is renamed or erased."""

    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="activity")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    verb = models.CharField(max_length=30)
    # "page", "table", "row" or "" for the workspace itself.
    target_kind = models.CharField(max_length=10, blank=True)
    target_id = models.PositiveIntegerField(null=True, blank=True)
    title = models.CharField(max_length=200, blank=True)
    detail = models.JSONField(default=dict)
    created_at = models.DateTimeField(db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["workspace", "target_kind", "target_id"])]


class Notification(models.Model):
    """Something in a workspace that's for you: a mention, a row assigned to you, a comment."""

    class Kind(models.TextChoices):
        MENTION = "mention", "Mention"
        ASSIGNED = "assigned", "Assigned"
        COMMENT = "comment", "Comment"

    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="workspace_notifications")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    workspace = models.ForeignKey(Workspace, on_delete=models.CASCADE, related_name="notifications")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    title = models.CharField(max_length=240)
    body = models.CharField(max_length=280, blank=True)
    url = models.CharField(max_length=200)
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["recipient", "read_at"])]
