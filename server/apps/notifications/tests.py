from django.utils import timezone
from datetime import datetime, timedelta, timezone as dt_timezone
from unittest import mock

import requests
from django.test import override_settings
from pywebpush import WebPushException
from rest_framework.test import APITestCase

from apps.tasks.models import Task
from apps.users.models import User

from .models import PushSubscription, ReminderRun
from .push import send_push as real_send_push
from .reminders import RETRY_AFTER, send_due_reminders

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

    def test_a_network_failure_does_not_lose_the_reminder(self, send_push):
        task = self.make("back muscles", 5, remind_before_minutes=10)
        send_push.side_effect = requests.ConnectionError("no route")
        self.assertEqual(send_due_reminders(NOW), 0)
        task.refresh_from_db()
        self.assertIsNone(task.reminder_sent_at)

        # Not again straight away: the next minute's run leaves it, then it's tried once more.
        send_push.reset_mock(side_effect=True)
        self.assertEqual(send_due_reminders(NOW + timedelta(minutes=1)), 0)
        send_push.assert_not_called()
        self.assertEqual(send_due_reminders(NOW + RETRY_AFTER), 1)
        send_push.assert_called_once()
        task.refresh_from_db()
        self.assertEqual(task.reminder_sent_at, NOW + RETRY_AFTER)
        self.assertEqual(send_due_reminders(NOW + RETRY_AFTER * 2), 0)

    def test_a_refused_push_is_tried_again_too(self, send_push):
        task = self.make("again", 5)
        send_push.side_effect = WebPushException("push service said 500")
        self.assertEqual(send_due_reminders(NOW), 0)
        task.refresh_from_db()
        self.assertIsNone(task.reminder_sent_at)

    def test_it_stops_trying_an_hour_after_the_task(self, send_push):
        self.make("old", 5)
        send_push.side_effect = requests.Timeout()
        send_due_reminders(NOW)
        send_push.reset_mock(side_effect=True)
        self.assertEqual(send_due_reminders(NOW + timedelta(minutes=66)), 0)
        send_push.assert_not_called()

    def test_one_failure_does_not_stop_the_other_reminders(self, send_push):
        first, second = self.make("first", 5), self.make("second", 6)
        send_push.side_effect = [requests.ConnectionError(), None]
        self.assertEqual(send_due_reminders(NOW), 1)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual({first.reminder_sent_at is None, second.reminder_sent_at is None}, {True, False})

    def test_one_device_reaching_it_is_enough(self, send_push):
        other = PushSubscription.objects.create(user=self.user, endpoint="https://push.example.com/3", p256dh="k", auth="a")
        task = self.make("two devices", 5)
        send_push.side_effect = lambda subscription, *a, **k: (_ for _ in ()).throw(requests.Timeout()) if subscription == other else None
        self.assertEqual(send_due_reminders(NOW), 1)
        task.refresh_from_db()
        self.assertEqual(task.reminder_sent_at, NOW)

    def test_a_crash_while_sending_still_records_the_run(self, send_push):
        self.make("boom", 5)
        with mock.patch("apps.notifications.reminders._reminder_body", side_effect=ValueError("bad")):
            self.assertEqual(send_due_reminders(NOW), 0)
        self.assertEqual(ReminderRun.last().last_failed, 1)
        self.assertIsNotNone(ReminderRun.last().last_run_at)

    def test_a_run_that_died_part_way_is_picked_up_again(self, send_push):
        task = self.make("died", 5)
        Task.objects.filter(pk=task.pk).update(reminder_claimed_at=NOW - RETRY_AFTER)
        self.assertEqual(send_due_reminders(NOW), 1)

    def test_every_reminder_is_time_sensitive_and_only_high_priority_stays_on_screen(self, send_push):
        self.make("normal", 5)
        send_due_reminders(NOW)
        self.assertEqual((send_push.call_args.kwargs["time_sensitive"], send_push.call_args.kwargs["urgent"]), (True, False))
        self.make("big", 5, priority=Task.Priority.HIGH)
        send_due_reminders(NOW)
        self.assertEqual((send_push.call_args.kwargs["time_sensitive"], send_push.call_args.kwargs["urgent"]), (True, True))

    def test_changing_the_time_after_a_failed_try_can_send_straight_away(self, send_push):
        task = self.make("moved", 5)
        send_push.side_effect = requests.Timeout()
        send_due_reminders(NOW)
        task.refresh_from_db()
        self.assertIsNotNone(task.reminder_claimed_at)
        self.client.force_authenticate(self.user)
        response = self.client.patch(f"/api/tasks/{task.pk}/", {"due_at": (timezone.now() + timedelta(days=1)).isoformat()}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        task.refresh_from_db()
        self.assertIsNone(task.reminder_claimed_at)

    @override_settings(CRON_SECRET="s3cret")
    def test_the_job_gets_its_ok_even_if_one_part_fails(self, send_push):
        broken = mock.Mock(side_effect=RuntimeError("mail down"))
        broken.__name__ = "send_due_emails"
        with mock.patch("apps.notifications.views.send_due_emails", broken):
            response = self.client.post("/api/push/send-due/", HTTP_X_CRON_SECRET="s3cret")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["emails"])
        self.assertEqual(response.data["sent"], 0)

    @override_settings(CRON_SECRET="s3cret")
    def test_cron_endpoint_requires_secret(self, send_push):
        self.make("due", 5)
        self.assertEqual(self.client.post("/api/push/send-due/").status_code, 403)
        self.assertEqual(self.client.post("/api/push/send-due/", HTTP_X_CRON_SECRET="wrong").status_code, 403)
        with mock.patch("apps.notifications.reminders.timezone.now", return_value=NOW):
            response = self.client.post("/api/push/send-due/", HTTP_X_CRON_SECRET="s3cret")
        self.assertEqual(response.data, {"sent": 1, "emails": 0, "messages": 0})

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


class SendPushTests(APITestCase):
    def setUp(self):
        user = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())
        self.sub = PushSubscription.objects.create(user=user, endpoint="https://push.example.com/1", p256dh="k", auth="a")

    @mock.patch("apps.notifications.push.webpush")
    def test_never_waits_forever_and_reminders_go_out_right_away(self, webpush):
        real_send_push(self.sub, "t", "b", time_sensitive=True)
        self.assertEqual(webpush.call_args.kwargs["headers"], {"Urgency": "high"})
        self.assertGreater(webpush.call_args.kwargs["timeout"], 0)
        real_send_push(self.sub, "t", "b")
        self.assertEqual(webpush.call_args.kwargs["headers"], {"Urgency": "normal"})

    @mock.patch("apps.notifications.push.webpush", side_effect=requests.Timeout())
    def test_a_network_failure_shows_in_the_check_reminders_panel(self, webpush):
        with self.assertRaises(requests.Timeout):
            real_send_push(self.sub, "t", "b")
        self.sub.refresh_from_db()
        self.assertIn("Timeout", self.sub.last_error)
