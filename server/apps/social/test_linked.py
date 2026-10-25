from datetime import timedelta
from unittest import mock

from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.notifications.reminders import due_reminders
from apps.tasks.models import Task
from apps.users.models import User

from .models import Friendship, Share

PASSWORD = "Sunny-Clock-2026"


@override_settings(PUSH_SEND_ASYNC=False)
@mock.patch("apps.social.services.send_push")
class RemindFriendTests(APITestCase):
    """'Remind a friend': your task goes straight into their list, with a reminder, kept in sync."""

    def setUp(self):
        from apps.notifications.models import PushSubscription

        now = timezone.now()
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia Thompson", email_verified_at=now, reminders_enabled=True)
        self.aung = User.objects.create_user("aung@example.com", PASSWORD, full_name="Ko Aung", email_verified_at=now, reminders_enabled=True)
        self.sara = User.objects.create_user("sara@example.com", PASSWORD, full_name="Sara", email_verified_at=now)
        Friendship.objects.create(requester=self.mia, addressee=self.aung, status=Friendship.Status.ACCEPTED)
        PushSubscription.objects.create(user=self.aung, endpoint="https://push.example.com/aung", p256dh="k", auth="a")
        self.go_out = Task.objects.create(owner=self.mia, title="Go out", due_at=now + timedelta(hours=2), remind_before_minutes=None)
        self.client.force_authenticate(self.mia)

    def remind(self, *tasks, to=None):
        return self.client.post("/api/social/remind/", {"recipient_id": (to or self.aung).id, "task_ids": [t.id for t in tasks]}, format="json")

    def their_copy(self):
        return Task.objects.get(owner=self.aung)

    def test_lands_in_their_list_with_a_reminder_and_a_push(self, send_push):
        result = self.remind(self.go_out)
        self.assertEqual(result.status_code, 201, result.data)
        self.assertEqual((result.data["mode"], result.data["added"]), ("added", 1))
        copy = self.their_copy()
        self.assertEqual((copy.title, copy.due_at, copy.added_by, copy.linked_from), ("Go out", self.go_out.due_at, self.mia, self.go_out))
        self.assertEqual(copy.remind_before_minutes, 10)  # reminders on even though Mia's has none
        self.assertEqual(send_push.call_args.args[1], "Mia Thompson added a task for you")

        # Aung sees who added it; Mia sees who it's shared with.
        self.client.force_authenticate(self.aung)
        row = self.client.get("/api/tasks/").data[0]
        self.assertEqual((row["added_by_name"], row["linked"]), ("Mia Thompson", True))
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.get("/api/tasks/").data[0]["shared_with"], ["Ko"])

        # Their reminder fires like their own task's.
        copy.due_at = timezone.now() + timedelta(minutes=5)
        copy.save()
        self.assertIn(copy, due_reminders(timezone.now()))

        # Sending it again doesn't duplicate.
        self.assertEqual(self.remind(self.go_out).data["already"], 1)
        self.assertEqual(Task.objects.filter(owner=self.aung).count(), 1)

    def test_moving_renaming_and_deleting_follow_through(self, send_push):
        self.remind(self.go_out)
        later = self.go_out.due_at + timedelta(hours=1)
        self.client.patch(f"/api/tasks/{self.go_out.id}/", {"due_at": later.isoformat(), "title": "Go out for dinner"}, format="json")
        copy = self.their_copy()
        self.assertEqual((copy.title, copy.due_at), ("Go out for dinner", later))
        self.assertEqual(send_push.call_args.args[1], "Mia Thompson moved a task")

        # Ticking done is personal: it doesn't touch Aung's copy.
        self.client.patch(f"/api/tasks/{self.go_out.id}/", {"done": True}, format="json")
        self.assertFalse(self.their_copy().done)

        self.client.delete(f"/api/tasks/{self.go_out.id}/")
        self.assertFalse(Task.objects.filter(owner=self.aung).exists())
        self.assertTrue(Task.all_objects.filter(owner=self.aung, deleted_at__isnull=False).exists())  # in their Recently deleted
        self.assertEqual(send_push.call_args.args[1], "Mia Thompson cancelled a task")

    def test_their_own_edits_unlink_it(self, send_push):
        self.remind(self.go_out)
        copy = self.their_copy()
        self.client.force_authenticate(self.aung)
        self.client.patch(f"/api/tasks/{copy.id}/", {"done": True}, format="json")
        self.assertTrue(Task.objects.get(pk=copy.pk).linked_from_id)  # done keeps the link
        self.client.patch(f"/api/tasks/{copy.id}/", {"title": "My plan"}, format="json")
        self.assertIsNone(Task.objects.get(pk=copy.pk).linked_from_id)

        self.client.force_authenticate(self.mia)
        self.client.patch(f"/api/tasks/{self.go_out.id}/", {"title": "Changed"}, format="json")
        self.assertEqual(Task.objects.get(pk=copy.pk).title, "My plan")

    def test_friends_only_inbox_choice_past_tasks_and_unfriending(self, send_push):
        self.assertEqual(self.remind(self.go_out, to=self.sara).status_code, 403)  # not friends

        User.objects.filter(pk=self.aung.pk).update(friends_can_add_tasks=False)
        result = self.remind(self.go_out)
        self.assertEqual(result.data["mode"], "inbox")
        self.assertFalse(Task.objects.filter(owner=self.aung).exists())
        self.assertEqual(Share.objects.filter(recipient=self.aung).count(), 1)

        User.objects.filter(pk=self.aung.pk).update(friends_can_add_tasks=True)
        over = Task.objects.create(owner=self.mia, title="Earlier", due_at=timezone.now() - timedelta(hours=1))
        self.assertEqual(self.remind(over).data["past"], 1)

        self.remind(self.go_out)
        friendship = Friendship.objects.get()
        self.client.delete(f"/api/social/friends/{friendship.id}/")
        copy = self.their_copy()
        self.assertIsNone(copy.linked_from_id)  # stays in their list, stops following
        self.client.patch(f"/api/tasks/{self.go_out.id}/", {"title": "Changed"}, format="json")
        self.assertEqual(self.their_copy().title, "Go out")
