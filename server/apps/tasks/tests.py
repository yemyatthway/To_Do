from datetime import datetime, timedelta, timezone as dt_timezone

from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.models import User

from .models import Task

UTC = dt_timezone.utc


class TaskApiTests(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user("mia@example.com", "Sunny-Clock-2026", timezone="Asia/Yangon", email_verified_at=timezone.now())
        self.client.force_authenticate(self.user)
        self.tomorrow = (timezone.now() + timedelta(days=1)).isoformat()

    def test_create_list_update_delete(self):
        created = self.client.post(
            "/api/tasks/",
            {"title": "  Call the dentist ", "due_at": self.tomorrow, "category": "personal"},
            format="json",
        )
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["title"], "Call the dentist")
        task_id = created.data["id"]
        self.assertEqual(Task.objects.get(id=task_id).owner, self.user)

        listed = self.client.get("/api/tasks/")
        self.assertEqual([t["id"] for t in listed.data], [task_id])

        updated = self.client.patch(f"/api/tasks/{task_id}/", {"done": True}, format="json")
        self.assertEqual(updated.status_code, 200)
        self.assertIsNotNone(updated.data["completed_at"])

        undone = self.client.patch(f"/api/tasks/{task_id}/", {"done": False}, format="json")
        self.assertIsNone(undone.data["completed_at"])

        self.assertEqual(self.client.delete(f"/api/tasks/{task_id}/").status_code, 204)
        self.assertFalse(Task.objects.exists())

    def test_users_only_see_their_own_tasks(self):
        other = User.objects.create_user("aung@example.com", "Sunny-Clock-2026", email_verified_at=timezone.now())
        theirs = Task.objects.create(owner=other, title="theirs")
        Task.objects.create(owner=self.user, title="mine")

        self.assertEqual([t["title"] for t in self.client.get("/api/tasks/").data], ["mine"])
        self.assertEqual(self.client.get(f"/api/tasks/{theirs.id}/").status_code, 404)
        self.assertEqual(self.client.patch(f"/api/tasks/{theirs.id}/", {"done": True}, format="json").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/tasks/{theirs.id}/").status_code, 404)
        self.assertTrue(Task.objects.filter(id=theirs.id, done=False).exists())

    def test_owner_cannot_be_set_by_client(self):
        other = User.objects.create_user("aung@example.com", "Sunny-Clock-2026", email_verified_at=timezone.now())
        created = self.client.post("/api/tasks/", {"title": "x", "owner": other.id}, format="json")
        self.assertEqual(Task.objects.get(id=created.data["id"]).owner, self.user)

    def test_blank_title_rejected(self):
        response = self.client.post("/api/tasks/", {"title": "   "}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("title", response.data)

    def test_range_filter_with_anytime(self):
        day = datetime(2026, 10, 25, tzinfo=UTC)
        inside = Task.objects.create(owner=self.user, title="inside", due_at=day + timedelta(hours=9))
        Task.objects.create(owner=self.user, title="before", due_at=day - timedelta(minutes=1))
        Task.objects.create(owner=self.user, title="at end", due_at=day + timedelta(days=1))
        anytime = Task.objects.create(owner=self.user, title="anytime", due_at=None)

        params = {"start": "2026-10-25T00:00:00Z", "end": "2026-10-26T00:00:00Z"}
        response = self.client.get("/api/tasks/", params)
        self.assertEqual([t["id"] for t in response.data], [inside.id])

        response = self.client.get("/api/tasks/", {**params, "anytime": "1"})
        self.assertEqual([t["id"] for t in response.data], [inside.id, anytime.id])

    def test_bad_range_rejected(self):
        response = self.client.get("/api/tasks/", {"start": "2026-10-25"})
        self.assertEqual(response.status_code, 400)

    def test_changing_time_rearms_reminder(self):
        task = Task.objects.create(
            owner=self.user,
            title="t",
            due_at=datetime(2026, 10, 25, 9, tzinfo=UTC),
            reminder_sent_at=datetime(2026, 10, 25, 8, 50, tzinfo=UTC),
        )
        self.client.patch(f"/api/tasks/{task.id}/", {"title": "renamed"}, format="json")
        task.refresh_from_db()
        self.assertIsNotNone(task.reminder_sent_at)

        self.client.patch(f"/api/tasks/{task.id}/", {"due_at": self.tomorrow}, format="json")
        task.refresh_from_db()
        self.assertIsNone(task.reminder_sent_at)

    def test_past_dates_rejected_for_new_and_moved_tasks(self):
        now = timezone.now()
        yesterday = (now - timedelta(days=1)).isoformat()
        created = self.client.post("/api/tasks/", {"title": "late", "due_at": yesterday}, format="json")
        self.assertEqual(created.status_code, 400)
        self.assertEqual(created.data["due_at"], ["Pick today or a later date."])

        # Earlier today is still "today" and allowed.
        local_midnight = timezone.localtime(now, timezone.get_fixed_timezone(390)).replace(hour=0, minute=1)
        self.assertEqual(self.client.post("/api/tasks/", {"title": "this morning", "due_at": local_midnight.isoformat()}, format="json").status_code, 201)

        # An existing task from the past can still be edited, but not moved to another past day.
        old = Task.objects.create(owner=self.user, title="old", due_at=now - timedelta(days=3))
        self.assertEqual(self.client.patch(f"/api/tasks/{old.id}/", {"done": True, "title": "old, done"}, format="json").status_code, 200)
        self.assertEqual(self.client.patch(f"/api/tasks/{old.id}/", {"due_at": yesterday}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(f"/api/tasks/{old.id}/", {"due_at": self.tomorrow}, format="json").status_code, 200)


class OverdueTests(APITestCase):
    def test_only_unfinished_tasks_before_the_bound(self):
        from datetime import timedelta

        user = User.objects.create_user("mia@example.com", "Sunny-Clock-2026", email_verified_at=timezone.now())
        other = User.objects.create_user("aung@example.com", "Sunny-Clock-2026", email_verified_at=timezone.now())
        now = timezone.now()
        Task.objects.create(owner=user, title="missed", due_at=now - timedelta(days=3))
        Task.objects.create(owner=user, title="missed yesterday", due_at=now - timedelta(days=1))
        Task.objects.create(owner=user, title="done already", due_at=now - timedelta(days=2), done=True)
        Task.objects.create(owner=user, title="later", due_at=now + timedelta(days=1))
        Task.objects.create(owner=user, title="anytime")
        Task.objects.create(owner=other, title="not mine", due_at=now - timedelta(days=1))
        Task.objects.create(owner=user, title="deleted", due_at=now - timedelta(days=1), deleted_at=now)
        self.client.force_authenticate(user)
        response = self.client.get("/api/tasks/", {"overdue_before": now.isoformat()})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([t["title"] for t in response.data], ["missed yesterday", "missed"])


class ReminderLeadTests(APITestCase):
    def test_any_lead_from_at_the_time_to_a_day(self):
        from datetime import timedelta as td

        from apps.notifications.reminders import _lead, due_reminders

        user = User.objects.create_user("mia@example.com", "Sunny-Clock-2026", email_verified_at=timezone.now(), reminders_enabled=True)
        self.client.force_authenticate(user)
        due = (timezone.now() + td(hours=3)).isoformat()
        ok = self.client.post("/api/tasks/", {"title": "Flight", "due_at": due, "remind_before_minutes": 120}, format="json")
        self.assertEqual(ok.status_code, 201, ok.data)
        self.assertEqual(self.client.post("/api/tasks/", {"title": "x", "due_at": due, "remind_before_minutes": 2000}, format="json").status_code, 400)
        self.assertEqual(self.client.post("/api/tasks/", {"title": "x", "due_at": due, "remind_before_minutes": 0}, format="json").status_code, 201)

        task = Task.objects.get(title="Flight")
        self.assertNotIn(task, due_reminders(timezone.now()))  # 3 h away, reminder at 2 h before
        self.assertIn(task, due_reminders(timezone.now() + td(hours=1, minutes=1)))
        self.assertEqual([_lead(m) for m in (5, 60, 90, 120, 1440)], ["5 min", "1 h", "1 h 30 min", "2 h", "1 day"])


class SafeRetryTests(APITestCase):
    """What the app relies on when the network drops or a reply gets lost."""

    CLIENT_ID = "6f1c2a7e-5b3d-4c8e-9a10-1234567890ab"

    def setUp(self):
        self.user = User.objects.create_user("mia@example.com", "Sunny-Clock-2026", timezone="Asia/Yangon", email_verified_at=timezone.now())
        self.client.force_authenticate(self.user)

    def create(self, title="Call the dentist"):
        return self.client.post("/api/tasks/", {"title": title, "client_id": self.CLIENT_ID}, format="json")

    def test_sending_a_new_task_twice_saves_one(self):
        first, again = self.create(), self.create("A different title in a retry")
        self.assertEqual((first.status_code, again.status_code), (201, 200))
        self.assertEqual(first.data["id"], again.data["id"])
        self.assertEqual(again.data["title"], "Call the dentist")
        self.assertEqual(Task.objects.count(), 1)

    def test_a_late_resend_does_not_bring_back_a_deleted_task(self):
        task_id = self.create().data["id"]
        self.client.delete(f"/api/tasks/{task_id}/")
        self.assertEqual(self.create().status_code, 200)
        self.assertEqual(Task.objects.count(), 0)
        self.assertEqual(Task.all_objects.count(), 1)

    def test_two_people_can_use_the_same_client_id(self):
        self.create()
        other = User.objects.create_user("aung@example.com", "Sunny-Clock-2026", email_verified_at=timezone.now())
        self.client.force_authenticate(other)
        self.assertEqual(self.create().status_code, 201)

    def test_a_bad_client_id_is_refused(self):
        response = self.client.post("/api/tasks/", {"title": "x", "client_id": "nope"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("client_id", response.data)

    def test_client_id_cannot_be_changed_later(self):
        task_id = self.create().data["id"]
        self.client.patch(f"/api/tasks/{task_id}/", {"client_id": "11111111-1111-4111-8111-111111111111"}, format="json")
        self.assertEqual(str(Task.objects.get(pk=task_id).client_id), self.CLIENT_ID)

    def test_an_edit_made_from_an_old_copy_is_refused_not_overwritten(self):
        task_id = self.create().data["id"]
        self.client.patch(f"/api/tasks/{task_id}/", {"title": "Changed on my laptop"}, format="json")
        stale = self.client.patch(f"/api/tasks/{task_id}/", {"title": "From my phone", "base": {"title": "Call the dentist"}}, format="json")
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.data["task"]["title"], "Changed on my laptop")
        self.assertEqual(Task.objects.get(pk=task_id).title, "Changed on my laptop")

    def test_different_fields_merge_and_a_lost_reply_can_be_resent(self):
        task_id = self.create().data["id"]
        self.client.patch(f"/api/tasks/{task_id}/", {"title": "Renamed elsewhere"}, format="json")
        # Only "done" is being changed, and nobody else touched it: no conflict.
        done = self.client.patch(f"/api/tasks/{task_id}/", {"done": True, "base": {"done": False}}, format="json")
        self.assertEqual(done.status_code, 200)
        self.assertEqual(done.data["title"], "Renamed elsewhere")
        # Saved, but the reply never arrived: sending it again isn't a conflict.
        self.assertEqual(self.client.patch(f"/api/tasks/{task_id}/", {"done": True, "base": {"done": False}}, format="json").status_code, 200)

    def test_same_time_written_differently_is_not_a_conflict(self):
        due = (timezone.now() + timedelta(days=1)).replace(microsecond=0)
        task_id = self.client.post("/api/tasks/", {"title": "x", "due_at": due.isoformat()}, format="json").data["id"]
        new_due = (due + timedelta(hours=1)).isoformat()
        moved = self.client.patch(f"/api/tasks/{task_id}/", {"due_at": new_due, "base": {"due_at": due.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S+00:00")}}, format="json")
        self.assertEqual(moved.status_code, 200, moved.data)

    def test_a_failed_shared_update_saves_nothing(self):
        from unittest import mock

        task_id = self.create().data["id"]
        self.client.raise_request_exception = False
        with mock.patch("apps.social.linked.sync_copies", side_effect=RuntimeError("database hiccup")):
            response = self.client.patch(f"/api/tasks/{task_id}/", {"title": "Half saved?"}, format="json")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(Task.objects.get(pk=task_id).title, "Call the dentist")
