import json

from django.conf import settings
from pywebpush import WebPushException, webpush


def send_push(subscription, title, body, url="/", urgent=False):
    """Send one notification. Deletes the subscription if the browser revoked it.
    urgent: delivered right away even in battery saver, and stays on screen until dismissed."""
    try:
        webpush(
            subscription_info=subscription.as_subscription_info(),
            data=json.dumps({"title": title, "body": body, "url": url, "urgent": urgent}),
            headers={"Urgency": "high" if urgent else "normal"},
            vapid_private_key=settings.VAPID_PRIVATE_KEY,
            vapid_claims={"sub": settings.VAPID_SUBJECT},
            ttl=60,
        )
    except WebPushException as exc:
        # 404/410 mean the subscription is gone for good.
        if exc.response is not None and exc.response.status_code in (404, 410):
            subscription.delete()
        raise
