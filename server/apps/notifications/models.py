from django.conf import settings
from django.db import models


class PushSubscription(models.Model):
    """A browser's Web Push subscription (one per browser/device)."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_subscriptions")
    endpoint = models.URLField(max_length=1000, unique=True)
    p256dh = models.CharField(max_length=255)
    auth = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    # For "Check reminders": did the last push to this device get through, and if not, why.
    last_success_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=300, blank=True)
    last_error_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return self.endpoint[:60]

    def as_subscription_info(self):
        return {"endpoint": self.endpoint, "keys": {"p256dh": self.p256dh, "auth": self.auth}}


class ReminderRun(models.Model):
    """One row: when the reminder check last ran (cron-job.org every minute in production).
    If this goes stale, nothing is calling /api/push/send-due/ and no reminders go out."""

    last_run_at = models.DateTimeField()
    last_sent = models.PositiveIntegerField(default=0)
    last_failed = models.PositiveIntegerField(default=0)

    @classmethod
    def record(cls, sent, failed):
        from django.utils import timezone

        cls.objects.update_or_create(pk=1, defaults={"last_run_at": timezone.now(), "last_sent": sent, "last_failed": failed})

    @classmethod
    def last(cls):
        return cls.objects.filter(pk=1).first()
