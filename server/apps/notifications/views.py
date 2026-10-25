import hmac

from django.conf import settings
from pywebpush import WebPushException
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from datetime import timedelta

from django.utils import timezone

from apps.tasks.models import Task

from .models import PushSubscription, ReminderRun
from .push import send_push
from .reminders import send_due_reminders


class SubscriptionSerializer(serializers.Serializer):
    endpoint = serializers.URLField(max_length=1000)
    keys = serializers.DictField(child=serializers.CharField())

    def validate_keys(self, keys):
        if not {"p256dh", "auth"} <= keys.keys():
            raise serializers.ValidationError("keys must include p256dh and auth.")
        return keys

    def save(self, user):
        data = self.validated_data
        # A browser belongs to whoever is logged in on it now.
        subscription, _ = PushSubscription.objects.update_or_create(
            endpoint=data["endpoint"],
            defaults={"user": user, "p256dh": data["keys"]["p256dh"], "auth": data["keys"]["auth"]},
        )
        return subscription


class VapidPublicKeyView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"public_key": settings.VAPID_PUBLIC_KEY})


class SubscribeView(APIView):
    """POST saves this browser's subscription; DELETE removes it (reminders off, or logging out)."""

    def post(self, request):
        serializer = SubscriptionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(request.user)
        return Response({"detail": "Subscribed."}, status=status.HTTP_201_CREATED)

    def delete(self, request):
        endpoint = request.data.get("endpoint")
        if not endpoint:
            return Response({"endpoint": ["This field is required."]}, status=status.HTTP_400_BAD_REQUEST)
        PushSubscription.objects.filter(user=request.user, endpoint=endpoint).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TestPushView(APIView):
    """Save the browser's subscription, then immediately push a test notification to it."""

    def post(self, request):
        serializer = SubscriptionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        subscription = serializer.save(request.user)

        try:
            send_push(subscription, "It works!", "This push came from your Django server.")
        except WebPushException as exc:
            detail = exc.response.text if exc.response is not None else str(exc)
            return Response({"detail": f"Push failed: {detail}"}, status=status.HTTP_502_BAD_GATEWAY)

        return Response({"detail": "Push sent."})


class ReminderStatusView(APIView):
    """GET ?endpoint=<this browser's subscription>: everything that has to be true for reminders
    to arrive, for the "Check reminders" panel."""

    def get(self, request):
        user = request.user
        now = timezone.now()
        run = ReminderRun.last()
        this_endpoint = request.query_params.get("endpoint", "")
        upcoming = (
            Task.objects.filter(owner=user, done=False, due_at__gte=now - timedelta(hours=1), due_at__lte=now + timedelta(days=2))
            .order_by("due_at")[:5]
        )
        return Response(
            {
                "reminders_enabled": user.reminders_enabled,
                "service": {
                    "last_run_at": run.last_run_at if run else None,
                    # cron-job.org calls every minute; a few minutes of silence means it stopped.
                    "running": bool(run and run.last_run_at > now - timedelta(minutes=3)),
                },
                "devices": [
                    {
                        "id": s.pk,
                        "this_device": s.endpoint == this_endpoint,
                        "added_at": s.created_at,
                        "last_success_at": s.last_success_at,
                        "last_error": s.last_error if s.last_error_at and (not s.last_success_at or s.last_error_at > s.last_success_at) else "",
                    }
                    for s in user.push_subscriptions.order_by("-created_at")
                ],
                "upcoming": [
                    {
                        "title": t.title,
                        "due_at": t.due_at,
                        "remind_at": t.due_at - timedelta(minutes=t.remind_before_minutes) if t.remind_before_minutes else None,
                        "sent": t.reminder_sent_at is not None,
                    }
                    for t in upcoming
                ],
            }
        )


class SendDueRemindersView(APIView):
    """
    Called every minute by an external scheduler (e.g. cron-job.org) in production,
    with the X-Cron-Secret header set to CRON_SECRET.
    """

    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        secret = settings.CRON_SECRET
        given = request.headers.get("X-Cron-Secret", "")
        if not secret or not hmac.compare_digest(given, secret):
            return Response({"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN)
        return Response({"sent": send_due_reminders()})
