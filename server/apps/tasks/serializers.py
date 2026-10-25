from zoneinfo import ZoneInfo

from django.utils import timezone
from rest_framework import serializers

from .models import Task


class TaskSerializer(serializers.ModelSerializer):
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
        ]
        read_only_fields = ["completed_at", "created_at", "updated_at", "deleted_at"]

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
