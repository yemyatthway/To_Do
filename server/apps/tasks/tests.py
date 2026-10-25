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
