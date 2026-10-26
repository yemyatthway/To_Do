import logging

from .models import AuthEvent

logger = logging.getLogger("apps.users.auth")


def record(user, kind, ip=None):
    """Write an auth event to the database and the server log. Only logins keep an IP address."""
    if kind != AuthEvent.Kind.LOGIN:
        ip = None
    AuthEvent.objects.create(user=user, email=user.email, kind=kind, ip_address=ip)
    logger.info("auth %s user=%s ip=%s", kind, user.pk, ip or "-")
    from apps.live import ably

    ably.to_admins("activity", {"kind": kind})  # open admin dashboards refresh their log
