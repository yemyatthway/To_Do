import json

import requests
from django.conf import settings
from pywebpush import WebPushException, webpush

# How long to wait for Apple's or Google's push service before trying again later.
SEND_TIMEOUT_SECONDS = 10


def send_push(subscription, title, body, url="/", urgent=False, time_sensitive=False):
    """Send one notification. Deletes the subscription if the browser revoked it.
    time_sensitive: delivered right away even in battery saver. urgent: that, and it stays on
    screen until dismissed. Remembers on the subscription whether it worked, for the "Check
    reminders" panel. Raises WebPushException or a requests error if it didn't."""
    from django.utils import timezone

    try:
        webpush(
            subscription_info=subscription.as_subscription_info(),
            data=json.dumps({"title": title, "body": body, "url": url, "urgent": urgent}),
            headers={"Urgency": "high" if urgent or time_sensitive else "normal"},
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims={"sub": settings.VAPID_SUBJECT},
            # How long the push service keeps it for a phone that's asleep or offline. Reminders
            # come 10 min early, so holding it 10 min means a briefly unreachable phone still gets it.
            ttl=600,
            timeout=SEND_TIMEOUT_SECONDS,
        )
    except WebPushException as exc:
        # 404/410 mean the subscription is gone for good.
        if exc.response is not None and exc.response.status_code in (404, 410):
            subscription.delete()
        elif subscription.pk:
            code = exc.response.status_code if exc.response is not None else "no response"
            subscription.last_error = f"{code}: {exc.response.text if exc.response is not None else exc}"[:300]
            subscription.last_error_at = timezone.now()
            subscription.save(update_fields=["last_error", "last_error_at"])
        raise
    except requests.RequestException as exc:
        # The push service couldn't be reached at all, like a network failure or a timeout.
        if subscription.pk:
            subscription.last_error = f"no response: {type(exc).__name__}"
            subscription.last_error_at = timezone.now()
            subscription.save(update_fields=["last_error", "last_error_at"])
        raise
    if subscription.pk:
        subscription.last_success_at = timezone.now()
        subscription.save(update_fields=["last_success_at"])
