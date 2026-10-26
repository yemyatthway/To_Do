import re
from datetime import timedelta

from django.conf import settings
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.notifications.reminders import due_reminders
from apps.social.models import Friendship
from apps.tasks.models import Task

from .cleanup import prune
from .models import AuthEvent, User

PASSWORD = "Sunny-Clock-2026"


@override_settings(EMAIL_SEND_ASYNC=False)
class AccountSoftDeleteTests(APITestCase):
    def setUp(self):
        cache.clear()
        now = timezone.now()
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=now, reminders_enabled=True)
        self.aung = User.objects.create_user("aung@example.com", PASSWORD, full_name="Aung", email_verified_at=now)
        Friendship.objects.create(requester=self.mia, addressee=self.aung, status=Friendship.Status.ACCEPTED)
        self.task = Task.objects.create(owner=self.mia, title="Call mom", due_at=now + timedelta(minutes=5), remind_before_minutes=10)

    def delete_mia(self):
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.delete("/api/auth/me/", {"password": PASSWORD}, format="json").status_code, 204)
        self.client.force_authenticate(None)

    def login(self, **extra):
        return self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD, **extra}, format="json")

    def test_deleted_account_disappears_for_everyone_else(self):
        self.assertEqual(len(due_reminders(timezone.now())), 1)
        self.delete_mia()
        self.assertEqual(due_reminders(timezone.now()), [])
        self.client.force_authenticate(self.aung)
        self.assertEqual(self.client.get("/api/social/friends/").data["friends"], [])
        self.assertEqual(self.client.get("/api/social/users/", {"q": "mia@example.com"}).data, [])
        # The email stays reserved while the account can come back.
        self.client.force_authenticate(None)
        taken = self.client.post("/api/auth/register/", {"full_name": "M", "username": "mia", "email": "mia@example.com", "password": PASSWORD}, format="json")
        self.assertIn("Log in to restore it", taken.data["email"][0])

    def test_restore_needs_the_password_and_an_email_code_then_everything_is_back(self):
        self.delete_mia()
        self.assertEqual(self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": "wrong-Pass-123"}, format="json").status_code, 401)
        offer = self.login()
        self.assertTrue(offer.data["account_deleted"])
        self.assertIn("restore_until", offer.data)

        step = self.login(restore=True)
        self.assertTrue(step.data["two_factor_required"])  # its trusted devices were forgotten
        self.assertIsNotNone(User.all_objects.get(pk=self.mia.pk).deleted_at)  # not until the code
        code = re.search(r"\b(\d{6})\b", mail.outbox[-1].subject).group(1)
        done = self.client.post("/api/auth/login/verify/", {"challenge": step.data["challenge"], "code": code}, format="json")
        self.assertEqual(done.status_code, 200, done.data)
        self.assertIn("access", done.data)

        self.mia.refresh_from_db()
        self.assertIsNone(self.mia.deleted_at)
        self.assertTrue(self.mia.is_active)
        self.assertEqual(Task.objects.filter(owner=self.mia).count(), 1)
        self.client.force_authenticate(self.aung)
        self.assertEqual(len(self.client.get("/api/social/friends/").data["friends"]), 1)  # friends come back too
        self.assertTrue(AuthEvent.objects.filter(user=self.mia, kind="restored").exists())

    def test_after_the_restore_window_it_is_gone_and_cleanup_erases_it(self):
        self.delete_mia()
        User.all_objects.filter(pk=self.mia.pk).update(deleted_at=timezone.now() - timedelta(days=settings.ACCOUNT_RESTORE_DAYS + 1))
        self.assertEqual(self.login().status_code, 401)
        counts = prune()
        self.assertEqual(counts["accounts"], 1)
        self.assertFalse(User.all_objects.filter(pk=self.mia.pk).exists())
        self.assertFalse(Task.all_objects.filter(title="Call mom").exists())
        self.assertFalse(Friendship.objects.exists())
        # The security log keeps its rows (without the user link) until it ages out.
        self.assertTrue(AuthEvent.objects.filter(email="mia@example.com", kind="deleted", user__isnull=True).exists())

    def test_admin_sees_deleted_accounts_separately(self):
        admin = User.objects.create_user("admin@example.com", PASSWORD, is_staff=True, email_verified_at=timezone.now())
        self.delete_mia()
        self.client.force_authenticate(admin)
        stats = self.client.get("/api/admin/stats/").data
        self.assertEqual((stats["total_users"], stats["deleted_users"]), (2, 1))
        rows = self.client.get("/api/admin/users/", {"status": "deleted"}).data["results"]
        self.assertEqual([(r["email"], r["status"]) for r in rows], [("mia@example.com", "deleted")])
        self.assertIsNotNone(rows[0]["erase_after"])
        self.assertEqual(self.client.get("/api/admin/users/", {"status": "active"}).data["count"], 2)
        self.assertEqual(self.client.post(f"/api/admin/users/{self.mia.pk}/ban/").status_code, 404)


class TaskTrashTests(APITestCase):
    def setUp(self):
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())
        self.other = User.objects.create_user("aung@example.com", PASSWORD, email_verified_at=timezone.now())
        self.client.force_authenticate(self.mia)
        self.task = Task.objects.create(owner=self.mia, title="Gym")

    def test_delete_moves_to_trash_then_restore(self):
        self.assertEqual(self.client.delete(f"/api/tasks/{self.task.pk}/").status_code, 204)
        self.assertEqual(self.client.get("/api/tasks/").data, [])
        self.assertEqual(self.client.get(f"/api/tasks/{self.task.pk}/").status_code, 404)
        trash = self.client.get("/api/tasks/trash/").data
        self.assertEqual([t["title"] for t in trash], ["Gym"])
        self.assertIsNotNone(trash[0]["deleted_at"])
        self.assertEqual(self.client.post(f"/api/tasks/{self.task.pk}/restore/").status_code, 200)
        self.assertEqual(len(self.client.get("/api/tasks/").data), 1)
        self.assertEqual(self.client.get("/api/tasks/trash/").data, [])

    def test_purge_empty_and_others_cannot_touch_it(self):
        self.client.delete(f"/api/tasks/{self.task.pk}/")
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.post(f"/api/tasks/{self.task.pk}/restore/").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/tasks/{self.task.pk}/purge/").status_code, 404)
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.delete(f"/api/tasks/{self.task.pk}/purge/").status_code, 204)
        self.assertFalse(Task.all_objects.exists())
        Task.objects.create(owner=self.mia, title="a").delete()  # model delete is a real delete
        two = Task.objects.create(owner=self.mia, title="b")
        self.client.delete(f"/api/tasks/{two.pk}/")
        self.assertEqual(self.client.delete("/api/tasks/trash/").status_code, 204)
        self.assertFalse(Task.all_objects.exists())

    def test_old_trash_is_erased_by_cleanup_and_hidden_meanwhile(self):
        self.client.delete(f"/api/tasks/{self.task.pk}/")
        Task.all_objects.filter(pk=self.task.pk).update(deleted_at=timezone.now() - timedelta(days=settings.TASK_RESTORE_DAYS, minutes=1))
        self.assertEqual(self.client.get("/api/tasks/trash/").data, [])
        self.assertEqual(prune()["tasks"], 1)
        self.assertFalse(Task.all_objects.exists())
