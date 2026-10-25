from django.utils import timezone
from datetime import datetime, timedelta, timezone as dt_timezone
from unittest import mock

from django.test import override_settings
from rest_framework.test import APITestCase

from apps.tasks.models import Task
from apps.users.models import User

from .models import PushSubscription
from .reminders import send_due_reminders

UTC = dt_timezone.utc
NOW = datetime(2026, 10, 25, 7, 0, tzinfo=UTC)
PASSWORD = "Sunny-Clock-2026"


@mock.patch("apps.notifications.reminders.send_push")
class ReminderTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user("mia@example.com", PASSWORD, reminders_enabled=True, timezone="Asia/Yangon", email_verified_at=timezone.now())
        self.sub = PushSubscription.objects.create(user=self.user, endpoint="https://push.example.com/1", p256dh="k", auth="a")

    def make(self, title, minutes_from_now, owner=None, **extra):
        return Task.objects.create(owner=owner or self.user, title=title, due_at=NOW + timedelta(minutes=minutes_from_now), **extra)

    def test_sends_only_reminders_that_are_due(self, send_push):
        due = self.make("in 5 min, remind 10 before", 5, remind_before_minutes=10)
        self.make("in 30 min, remind 10 before", 30, remind_before_minutes=10)
        self.make("done", 5, done=True)
        self.make("no reminder", 5, remind_before_minutes=None)
        self.make("stale", -120)

        self.assertEqual(send_due_reminders(NOW), 1)
        send_push.assert_called_once()
        subscription, title, body = send_push.call_args.args
        self.assertEqual((subscription, title), (self.sub, due.title))
        # 07:05 UTC is 1:35 PM in Yangon (+06:30).
        self.assertEqual(body, "Starts in 5 min · 1:35 PM")

        due.refresh_from_db()
        self.assertEqual(due.reminder_sent_at, NOW)
        self.assertEqual(send_due_reminders(NOW), 0)

    def test_reminders_go_only_to_the_owner_and_respect_the_off_switch(self, send_push):
        other = User.objects.create_user("aung@example.com", PASSWORD, reminders_enabled=False, email_verified_at=timezone.now())
        PushSubscription.objects.create(user=other, endpoint="https://push.example.com/2", p256dh="k", auth="a")
        self.make("mine", 5)
        self.make("theirs, reminders off", 5, owner=other)

        self.assertEqual(send_due_reminders(NOW), 1)
        self.assertEqual([c.args[0] for c in send_push.call_args_list], [self.sub])

    @override_settings(CRON_SECRET="s3cret")
    def test_cron_endpoint_requires_secret(self, send_push):
        self.make("due", 5)
        self.assertEqual(self.client.post("/api/push/send-due/").status_code, 403)
        self.assertEqual(self.client.post("/api/push/send-due/", HTTP_X_CRON_SECRET="wrong").status_code, 403)
        with mock.patch("apps.notifications.reminders.timezone.now", return_value=NOW):
            response = self.client.post("/api/push/send-due/", HTTP_X_CRON_SECRET="s3cret")
        self.assertEqual(response.data, {"sent": 1})

    @override_settings(CRON_SECRET="")
    def test_cron_endpoint_disabled_without_secret(self, send_push):
        self.assertEqual(self.client.post("/api/push/send-due/").status_code, 403)


class SubscriptionApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())
        self.client.force_authenticate(self.user)
        self.body = {"endpoint": "https://push.example.com/abc", "keys": {"p256dh": "k", "auth": "a"}}

    def test_subscribe_and_unsubscribe(self):
        self.assertEqual(self.client.post("/api/push/subscribe/", self.body, format="json").status_code, 201)
        self.assertEqual(PushSubscription.objects.get().user, self.user)

        self.assertEqual(self.client.delete("/api/push/subscribe/", {"endpoint": self.body["endpoint"]}, format="json").status_code, 204)
        self.assertFalse(PushSubscription.objects.exists())

    def test_browser_moves_to_whoever_subscribes_it_last(self):
        self.client.post("/api/push/subscribe/", self.body, format="json")
        other = User.objects.create_user("aung@example.com", PASSWORD, email_verified_at=timezone.now())
        self.client.force_authenticate(other)
        self.client.post("/api/push/subscribe/", self.body, format="json")
        self.assertEqual(PushSubscription.objects.get().user, other)

    def test_cannot_delete_someone_elses_subscription(self):
        other = User.objects.create_user("aung@example.com", PASSWORD, email_verified_at=timezone.now())
        PushSubscription.objects.create(user=other, endpoint=self.body["endpoint"], p256dh="k", auth="a")
        self.client.delete("/api/push/subscribe/", {"endpoint": self.body["endpoint"]}, format="json")
        self.assertTrue(PushSubscription.objects.exists())

    def test_requires_login(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.post("/api/push/subscribe/", self.body, format="json").status_code, 401)


class ReminderStatusTests(APITestCase):
    def test_status_shows_service_devices_and_next_reminders(self):
        from datetime import timedelta as td

        from apps.tasks.models import Task

        from .models import ReminderRun

        user = User.objects.create_user("mia@example.com", PASSWORD, reminders_enabled=True, email_verified_at=timezone.now())
        PushSubscription.objects.create(user=user, endpoint="https://push.example.com/me", p256dh="k", auth="a")
        Task.objects.create(owner=user, title="Gym", due_at=timezone.now() + td(minutes=30), remind_before_minutes=10)
        self.client.force_authenticate(user)

        data = self.client.get("/api/push/status/", {"endpoint": "https://push.example.com/me"}).data
        self.assertTrue(data["reminders_enabled"])
        self.assertFalse(data["service"]["running"])  # nothing has called send-due yet
        self.assertTrue(data["devices"][0]["this_device"])
        self.assertEqual(data["upcoming"][0]["title"], "Gym")

        with mock.patch("apps.notifications.reminders.send_push"):
            from .reminders import send_due_reminders

            send_due_reminders()
        self.assertIsNotNone(ReminderRun.last())
        self.assertTrue(self.client.get("/api/push/status/").data["service"]["running"])
