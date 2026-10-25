from django.conf import settings
from django.db import models


class LiveTaskManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class Task(models.Model):
    class Category(models.TextChoices):
        WORK = "work", "Work"
        PERSONAL = "personal", "Personal"
        HEALTH = "health", "Health"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="tasks")
    title = models.CharField(max_length=200)
    notes = models.TextField(blank=True)
    # Null means "anytime": the task has no slot on the clock.
    due_at = models.DateTimeField(null=True, blank=True, db_index=True)
    category = models.CharField(max_length=20, choices=Category.choices, default=Category.PERSONAL)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM)
    # Null means no reminder.
    remind_before_minutes = models.PositiveIntegerField(null=True, blank=True, default=10)
    done = models.BooleanField(default=False)
    completed_at = models.DateTimeField(null=True, blank=True)
    reminder_sent_at = models.DateTimeField(null=True, blank=True)
    # Soft delete: shown under "Recently deleted" and restorable for settings.TASK_RESTORE_DAYS.
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # The default hides deleted tasks everywhere (lists, reminders, sharing, counts).
    objects = LiveTaskManager()
    all_objects = models.Manager()

    class Meta:
        base_manager_name = "all_objects"
        ordering = [models.F("due_at").asc(nulls_last=True), "created_at"]
        # The main query: one person's tasks in a date range.
        indexes = [models.Index(fields=["owner", "due_at"])]

    def __str__(self):
        return self.title
