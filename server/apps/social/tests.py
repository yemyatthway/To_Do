from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.tasks.models import Task
from apps.users.models import User

from .models import Friendship, Share

PASSWORD = "Sunny-Clock-2026"


@override_settings(PUSH_SEND_ASYNC=False)
class SocialTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia Thompson", timezone="Asia/Yangon", email_verified_at=timezone.now())
        self.aung = User.objects.create_user("aung@example.com", PASSWORD, full_name="Ko Aung", timezone="Asia/Yangon", email_verified_at=timezone.now())
        self.sara = User.objects.create_user("sara@example.com", PASSWORD, full_name="Sara Lee", timezone="Asia/Yangon", email_verified_at=timezone.now())
        self.client.force_authenticate(self.mia)

    def as_user(self, user):
        self.client.force_authenticate(user)

    def befriend(self, a, b):
        return Friendship.objects.create(requester=a, addressee=b, status=Friendship.Status.ACCEPTED)

    # --- search -------------------------------------------------------------

    def test_search_masks_email_hides_self_and_banned(self):
        User.objects.create_user("banned@example.com", PASSWORD, full_name="Ko Banned", is_active=False, email_verified_at=timezone.now())
        results = self.client.get("/api/social/users/", {"q": "ko"}).data
        self.assertEqual([r["full_name"] for r in results], ["Ko Aung"])
        self.assertEqual(results[0]["email"], "a•••@example.com")
        self.assertEqual(results[0]["relationship"], "none")
        self.assertEqual(self.client.get("/api/social/users/", {"q": "mia"}).data, [])

    def test_search_by_exact_email_only_and_minimum_length(self):
        self.assertEqual(len(self.client.get("/api/social/users/", {"q": "sara@example.com"}).data), 1)
        self.assertEqual(self.client.get("/api/social/users/", {"q": "example.com"}).data, [])
        self.assertEqual(self.client.get("/api/social/users/", {"q": "k"}).data, [])

    # --- friend requests ----------------------------------------------------

    def test_request_accept_and_relationship_states(self):
        sent = self.client.post("/api/social/friends/requests/", {"user_id": self.aung.id}, format="json")
        self.assertEqual((sent.status_code, sent.data["relationship"]), (201, "outgoing"))
        friendship_id = sent.data["friendship_id"]

        # Mia can't accept her own request.
        self.assertEqual(self.client.post(f"/api/social/friends/{friendship_id}/accept/").status_code, 404)

        self.as_user(self.aung)
        self.assertEqual(self.client.get("/api/social/summary/").data["incoming_requests"], 1)
        self.assertEqual(self.client.get("/api/social/friends/").data["incoming"][0]["full_name"], "Mia Thompson")
        accepted = self.client.post(f"/api/social/friends/{friendship_id}/accept/")
        self.assertEqual(accepted.data["relationship"], "friends")
        self.assertTrue(Friendship.are_friends(self.mia, self.aung))

    def test_asking_back_accepts_instead_of_duplicating(self):
        self.client.post("/api/social/friends/requests/", {"user_id": self.aung.id}, format="json")
        self.as_user(self.aung)
        back = self.client.post("/api/social/friends/requests/", {"user_id": self.mia.id}, format="json")
        self.assertEqual(back.data["relationship"], "friends")
        self.assertEqual(Friendship.objects.count(), 1)

    def test_cannot_friend_self_and_can_unfriend(self):
        self.assertEqual(self.client.post("/api/social/friends/requests/", {"user_id": self.mia.id}, format="json").status_code, 404)
        friendship = self.befriend(self.mia, self.aung)
        self.as_user(self.sara)  # a stranger can't touch it
        self.assertEqual(self.client.delete(f"/api/social/friends/{friendship.id}/").status_code, 404)
        self.as_user(self.aung)
        self.assertEqual(self.client.delete(f"/api/social/friends/{friendship.id}/").status_code, 204)
        self.assertFalse(Friendship.objects.exists())

    # --- sharing ------------------------------------------------------------

    def test_only_friends_can_share_and_only_your_own_tasks(self):
        mine = Task.objects.create(owner=self.mia, title="mine")
        theirs = Task.objects.create(owner=self.sara, title="not mine")
        body = {"recipient_id": self.aung.id, "task_ids": [mine.id]}
        self.assertEqual(self.client.post("/api/social/shares/", body, format="json").status_code, 403)

        self.befriend(self.mia, self.aung)
        stolen = self.client.post("/api/social/shares/", {"recipient_id": self.aung.id, "task_ids": [theirs.id]}, format="json")
        self.assertEqual(stolen.status_code, 400)
        self.assertEqual(self.client.post("/api/social/shares/", body, format="json").status_code, 201)

    @mock.patch("apps.social.services.send_push")
    def test_share_is_a_snapshot_and_adding_copies_with_clash_report(self, send_push):
        self.befriend(self.mia, self.aung)
        tomorrow_2pm = (timezone.now() + timedelta(days=1)).replace(second=0, microsecond=0)
        standup = Task.objects.create(owner=self.mia, title="Standup", due_at=tomorrow_2pm, category="work")
        anytime = Task.objects.create(owner=self.mia, title="Buy milk")
        Task.objects.create(owner=self.aung, title="Gym", due_at=tomorrow_2pm)

        sent = self.client.post(
            "/api/social/shares/", {"recipient_id": self.aung.id, "task_ids": [standup.id, anytime.id], "message": "join us"}, format="json"
        )
        self.assertEqual(sent.status_code, 201)

        # Changing the original later doesn't change what was sent.
        standup.title = "Renamed"
        standup.save()

        self.as_user(self.aung)
        # Aung still can't see Mia's actual tasks.
        self.assertNotIn("Standup", [t["title"] for t in self.client.get("/api/tasks/").data])
        inbox = self.client.get("/api/social/shares/").data
        self.assertEqual(inbox[0]["message"], "join us")
        self.assertEqual([t["title"] for t in inbox[0]["tasks"]], ["Standup", "Buy milk"])
        self.assertEqual(self.client.get("/api/social/summary/").data["new_shares"], 1)

        added = self.client.post(f"/api/social/shares/{inbox[0]['id']}/add/", format="json").data
        self.assertEqual(added["added"], 2)
        self.assertEqual(added["share"]["status"], "added")
        self.assertEqual([(c["new"], c["existing"]) for c in added["clashes"]], [("Standup", "Gym")])
        titles = sorted(Task.objects.filter(owner=self.aung).values_list("title", flat=True))
        self.assertEqual(titles, ["Buy milk", "Gym", "Standup"])
        # Adding again doesn't duplicate.
        self.assertEqual(self.client.post(f"/api/social/shares/{inbox[0]['id']}/add/", format="json").data["added"], 0)

    def test_add_some_items_and_past_dates_go_to_anytime(self):
        self.befriend(self.mia, self.aung)
        old = Task.objects.create(owner=self.mia, title="Old", due_at=timezone.now() - timedelta(days=2))
        new = Task.objects.create(owner=self.mia, title="New", due_at=timezone.now() + timedelta(days=2))
        share_id = self.client.post("/api/social/shares/", {"recipient_id": self.aung.id, "task_ids": [old.id, new.id]}, format="json").data["id"]

        self.as_user(self.aung)
        items = {t["title"]: t["id"] for t in Share.objects.get(pk=share_id).tasks.values("id", "title")}
        first = self.client.post(f"/api/social/shares/{share_id}/add/", {"item_ids": [items["Old"]]}, format="json").data
        self.assertEqual(first["moved_to_anytime"], ["Old"])
        self.assertIsNone(Task.objects.get(owner=self.aung, title="Old").due_at)
        self.assertEqual(first["share"]["status"], "new")

    def test_strangers_cannot_read_add_or_dismiss_a_share(self):
        self.befriend(self.mia, self.aung)
        task = Task.objects.create(owner=self.mia, title="t")
        share_id = self.client.post("/api/social/shares/", {"recipient_id": self.aung.id, "task_ids": [task.id]}, format="json").data["id"]
        self.as_user(self.sara)
        self.assertEqual(self.client.get("/api/social/shares/").data, [])
        self.assertEqual(self.client.post(f"/api/social/shares/{share_id}/add/").status_code, 404)
        self.assertEqual(self.client.post(f"/api/social/shares/{share_id}/dismiss/").status_code, 404)
        self.as_user(self.aung)
        self.assertEqual(self.client.post(f"/api/social/shares/{share_id}/dismiss/").status_code, 204)
        self.assertEqual(self.client.get("/api/social/shares/").data, [])

    def test_requires_login(self):
        self.client.force_authenticate(None)
        for path in ["/api/social/users/?q=ko", "/api/social/friends/", "/api/social/shares/", "/api/social/summary/"]:
            self.assertEqual(self.client.get(path).status_code, 401, path)


@override_settings(PUSH_SEND_ASYNC=False)
class SocialNotificationTests(APITestCase):
    """Who gets a push for what. Only people with notifications on and a subscribed device."""

    def setUp(self):
        from apps.notifications.models import PushSubscription

        now = timezone.now()
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=now, reminders_enabled=True)
        self.aung = User.objects.create_user("aung@example.com", PASSWORD, full_name="Ko Aung", email_verified_at=now, reminders_enabled=True)
        for user in (self.mia, self.aung):
            PushSubscription.objects.create(user=user, endpoint=f"https://push.example.com/{user.pk}", p256dh="k", auth="a")

    def pushes(self, send_push):
        return [(call.args[0].user.email, call.args[1], call.args[2]) for call in send_push.call_args_list]

    @mock.patch("apps.social.services.send_push")
    def test_request_accept_and_share_each_notify_the_other_person(self, send_push):
        self.client.force_authenticate(self.mia)
        self.client.post("/api/social/friends/requests/", {"user_id": self.aung.id}, format="json")
        self.assertEqual(self.pushes(send_push)[-1], ("aung@example.com", "New friend request", "Mia wants to be friends."))

        self.client.force_authenticate(self.aung)
        request_id = Friendship.objects.get().pk
        self.client.post(f"/api/social/friends/{request_id}/accept/")
        self.assertEqual(self.pushes(send_push)[-1], ("mia@example.com", "Friend request accepted", "Ko Aung accepted your friend request."))

        task = Task.objects.create(owner=self.aung, title="Dinner")
        self.client.post("/api/social/shares/", {"recipient_id": self.mia.id, "task_ids": [task.id], "message": ""}, format="json")
        self.assertEqual(self.pushes(send_push)[-1], ("mia@example.com", "Ko Aung sent you 1 task", "Dinner"))
        self.assertEqual(send_push.call_args.kwargs["url"], "/?view=friends")

    @mock.patch("apps.social.services.send_push")
    def test_asking_back_tells_the_first_person_its_accepted(self, send_push):
        self.client.force_authenticate(self.mia)
        self.client.post("/api/social/friends/requests/", {"user_id": self.aung.id}, format="json")
        self.client.force_authenticate(self.aung)
        self.client.post("/api/social/friends/requests/", {"user_id": self.mia.id}, format="json")
        self.assertEqual(self.pushes(send_push)[-1][:2], ("mia@example.com", "Friend request accepted"))

    @mock.patch("apps.social.services.send_push")
    def test_nobody_is_pushed_with_notifications_off(self, send_push):
        User.objects.filter(pk=self.aung.pk).update(reminders_enabled=False)
        self.client.force_authenticate(self.mia)
        self.client.post("/api/social/friends/requests/", {"user_id": self.aung.id}, format="json")
        send_push.assert_not_called()
