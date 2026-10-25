from zoneinfo import ZoneInfo

from django.utils import timezone
from rest_framework import serializers

from .models import Task


class TaskSerializer(serializers.ModelSerializer):
    # "Remind a friend": who put this task in your list, whether it still follows their changes,
    # and (on your own tasks) which friends you added it for.
    added_by_name = serializers.SerializerMethodField()
    linked = serializers.SerializerMethodField()
    shared_with = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = [
            "id",
            "title",
            "notes",
            "due_at",
            "category",
            "priority",
            "remind_before_minutes",
            "done",
            "completed_at",
            "created_at",
            "updated_at",
            "deleted_at",
            "added_by_name",
            "linked",
            "shared_with",
        ]
        read_only_fields = ["completed_at", "created_at", "updated_at", "deleted_at"]

    def get_added_by_name(self, task):
        return (task.added_by.full_name or task.added_by.email) if task.added_by_id and task.added_by else None

    def get_linked(self, task):
        return task.linked_from_id is not None

    def get_shared_with(self, task):
        if not task.pk:
            return []
        return [(c.owner.full_name or c.owner.email).split()[0] for c in task.linked_copies.all()]

    def validate_title(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Enter a title.")
        return value

    def validate_due_at(self, value):
        # New tasks, and tasks being moved, can't land on a day that's already over for this user.
        # (Existing past tasks can still be renamed, ticked off or deleted.)
        if value is None or (self.instance is not None and value == self.instance.due_at):
            return value
        request = self.context.get("request")
        zone = user_zone(getattr(request, "user", None))
        if timezone.localtime(value, zone).date() < timezone.localtime(timezone.now(), zone).date():
            raise serializers.ValidationError("Pick today or a later date.")
        return value

    def update(self, instance, validated_data):
        # A new time or reminder setting means the reminder should fire again.
        if any(
            key in validated_data and validated_data[key] != getattr(instance, key)
            for key in ("due_at", "remind_before_minutes")
        ):
            instance.reminder_sent_at = None
        if "done" in validated_data and validated_data["done"] != instance.done:
            instance.completed_at = timezone.now() if validated_data["done"] else None
        return super().update(instance, validated_data)

    def create(self, validated_data):
        if validated_data.get("done"):
            validated_data["completed_at"] = timezone.now()
        return super().create(validated_data)


def user_zone(user):
    """The user's own time zone (kept in sync with their device), else the server's."""
    name = getattr(user, "timezone", "")
    try:
        return ZoneInfo(name) if name else timezone.get_current_timezone()
    except Exception:
        return timezone.get_current_timezone()
