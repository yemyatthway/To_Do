from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied, ValidationError
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

from .models import EmailCode, TrustedDevice, User

MAX_FAILED_LOGINS = 5
LOCKOUT_DURATION = timedelta(minutes=15)


def user_login(*, email, password, ip=None):
    """Same rules as afm_sys: generic error message, lock for 15 min after 5 bad passwords.
    A recently deleted account passes the password check too (deleted_at set), so the caller can
    offer to restore it; it's never signed in as it is."""
    user = User.all_objects.filter(email__iexact=email.strip()).first()
    if user is None:
        raise AuthenticationFailed("Invalid email or password.")

    now = timezone.now()
    if user.locked_until and user.locked_until > now:
        raise PermissionDenied("Too many failed attempts. Try again in 15 minutes.")

    if not user.check_password(password):
        user.failed_login_count += 1
        update_fields = ["failed_login_count"]
        if user.failed_login_count >= MAX_FAILED_LOGINS:
            user.locked_until = now + LOCKOUT_DURATION
            user.failed_login_count = 0
            update_fields.append("locked_until")
        user.save(update_fields=update_fields)
        raise AuthenticationFailed("Invalid email or password.")

    if user.deleted_at:
        return user
    if not user.is_active:
        raise PermissionDenied(
            "This account has been suspended." if user.banned_at else "This account is inactive."
        )

    user.failed_login_count = 0
    user.locked_until = None
    user.last_login_at = now
    user.last_login_ip = ip
    user.save(update_fields=["failed_login_count", "locked_until", "last_login_at", "last_login_ip"])
    return user


def change_password(*, user, old_password, new_password):
    if not user.check_password(old_password):
        raise ValidationError({"old_password": "Current password is incorrect."})
    if old_password == new_password:
        raise ValidationError({"new_password": "New password must differ from the current password."})
    user.set_password(new_password)
    user.password_changed_at = timezone.now()
    user.save(update_fields=["password", "password_changed_at"])
    return user


def ban_user(*, user, by, reason=""):
    """Suspend an account and end all its sessions right away."""
    if user.pk == by.pk:
        raise ValidationError({"detail": "You can't ban your own account."})
    if user.deleted_at:
        raise ValidationError({"detail": "This account was deleted by its owner."})
    if user.is_staff or user.is_superuser:
        raise PermissionDenied("Admin accounts can't be banned here.")
    user.is_active = False
    user.banned_at = timezone.now()
    user.ban_reason = reason.strip()[:255]
    user.save(update_fields=["is_active", "banned_at", "ban_reason"])
    # Refresh tokens die now; access tokens stop working on the next request (inactive users are rejected).
    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)
    return user


def unban_user(*, user):
    user.is_active = True
    user.banned_at = None
    user.ban_reason = ""
    user.failed_login_count = 0
    user.locked_until = None
    user.save(update_fields=["is_active", "banned_at", "ban_reason", "failed_login_count", "locked_until"])
    return user


def _end_sessions(user):
    for token in OutstandingToken.objects.filter(user=user):
        BlacklistedToken.objects.get_or_create(token=token)


def restore_deadline(user):
    return user.deleted_at + timedelta(days=settings.ACCOUNT_RESTORE_DAYS)


def delete_account(*, user, password):
    """Soft delete, after re-checking the password: the account disappears at once (logged out
    everywhere, hidden from friends and search, no reminders) but can be restored by logging in
    within ACCOUNT_RESTORE_DAYS. After that the daily clean-up erases it and everything it owns."""
    if not user.check_password(password):
        raise ValidationError({"password": "Password is incorrect."})
    _end_sessions(user)
    user.deleted_at = timezone.now()
    user.is_active = False
    user.save(update_fields=["deleted_at", "is_active"])
    # Nothing worth keeping: a restored account gets new ones the normal way.
    user.push_subscriptions.all().delete()
    TrustedDevice.objects.filter(user=user).delete()
    EmailCode.objects.filter(user=user).delete()
    return user


def restore_account(*, user):
    user.deleted_at = None
    user.is_active = True
    user.save(update_fields=["deleted_at", "is_active"])
    return user


def purge_account(user):
    """Erase for good: tasks, friendships, shares cascade; the auth log keeps its rows (user set to null)."""
    _end_sessions(user)
    user.delete()
