"""Keeps the database small: erases soft-deleted accounts and tasks once they can no longer be
restored, and deletes rows nobody will ever need again. Run daily
(`manage.py prune`, or POST /api/cron/prune/ from cron-job.org with X-Cron-Secret)."""

from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken

from apps.social.models import Share
from apps.tasks.models import Task

from .models import AuthEvent, EmailCode, TrustedDevice, User
from .services import purge_account

AUTH_LOG_DAYS = 180
FINISHED_SHARE_DAYS = 30


def prune(now=None):
    now = now or timezone.now()
    expired_accounts = list(User.all_objects.filter(deleted_at__lt=now - timedelta(days=settings.ACCOUNT_RESTORE_DAYS)))
    for user in expired_accounts:
        purge_account(user)
    counts = {
        # Soft-deleted accounts past their restore window: erased with everything they own.
        "accounts": len(expired_accounts),
        "tasks": Task.all_objects.filter(deleted_at__lt=now - timedelta(days=settings.TASK_RESTORE_DAYS)).delete()[0],
        # Codes are useless once expired; a day of history helps with "I never got the code" questions.
        "email_codes": EmailCode.objects.filter(expires_at__lt=now - timedelta(days=1)).delete()[0],
        "trusted_devices": TrustedDevice.objects.filter(created_at__lt=now - timedelta(days=settings.TRUSTED_DEVICE_DAYS)).delete()[0],
        # Expired refresh tokens (and their blacklist rows) can never be used again.
        "tokens": OutstandingToken.objects.filter(expires_at__lt=now).delete()[0],
        "auth_events": AuthEvent.objects.filter(created_at__lt=now - timedelta(days=AUTH_LOG_DAYS)).delete()[0],
        # Shares already added or dismissed (their task copies go with them).
        "shares": Share.objects.filter(
            status__in=[Share.Status.ADDED, Share.Status.DISMISSED], created_at__lt=now - timedelta(days=FINISHED_SHARE_DAYS)
        ).delete()[0],
    }
    return counts
