import json

from django.conf import settings
from pywebpush import WebPushException, webpush


def send_push(subscription, title, body, url="/", urgent=False):
    """Send one notification. Deletes the subscription if the browser revoked it.
    urgent: delivered right away even in battery saver, and stays on screen until dismissed.
    Remembers on the subscription whether it worked, for the "Check reminders" panel."""
    from django.utils import timezone

    try:
        webpush(
            subscription_info=subscription.as_subscription_info(),
            data=json.dumps({"title": title, "body": body, "url": url, "urgent": urgent}),
            headers={"Urgency": "high" if urgent else "normal"},
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims={"sub": settings.VAPID_SUBJECT},
            # How long the push service keeps it for a phone that's asleep or offline. Reminders
            # come 10 min early, so holding it 10 min means a briefly unreachable phone still gets it.
            ttl=600,
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
    if subscription.pk:
        subscription.last_success_at = timezone.now()
        subscription.save(update_fields=["last_success_at"])
