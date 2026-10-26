from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.social.models import Friendship

from . import usernames
from .models import User

PASSWORD = "Sunny-Clock-2026"
ORIGIN = "http://localhost:5173"


@override_settings(EMAIL_SEND_ASYNC=False)
class UsernameTests(APITestCase):
    def setUp(self):
        cache.clear()  # throttles
        now = timezone.now()
        self.kai = User.objects.create_user("kai@example.com", PASSWORD, full_name="Kai Min", email_verified_at=now)

    def register(self, username, email="new@example.com"):
        data = {"full_name": "New Person", "username": username, "email": email, "password": PASSWORD}
        return self.client.post("/api/auth/register/", data, format="json", HTTP_ORIGIN=ORIGIN)

    # --- rules and suggestions ------------------------------------------------

    def test_accounts_made_without_one_get_a_free_username_from_their_name(self):
        self.assertEqual(self.kai.username, "kaimin")
        twin = User.objects.create_user("kai2@example.com", PASSWORD, full_name="Kai Min")
        self.assertEqual(twin.username, "kaimin2")
        self.assertEqual(User.objects.create_user("zo@example.com", PASSWORD, full_name="Zoë").username, "zoe")
        self.assertEqual(User.objects.create_user("x.y@example.com", PASSWORD).username, "xyuser")  # too short alone
        self.assertIsNone(self.kai.username_confirmed_at)

    def test_rules(self):
        self.assertIsNone(usernames.problem("ryen.kai_2"))
        for bad in ["ab", "a" * 21, "Has Space", ".dot", "dot.", "two..dots", "admin", "hey!"]:
            self.assertIsNotNone(usernames.problem(usernames.normalize(bad) if bad != "Has Space" else bad), bad)

    # --- sign-up -----------------------------------------------------------------

    def test_sign_up_needs_a_free_valid_username_and_counts_as_chosen(self):
        self.assertIn("username", self.register("").data)
        self.assertIn("taken", self.register("KaiMin").data["username"][0])  # same name, different capitals
        self.assertIn("username", self.register("no way").data)
        created = self.register("@New.Person")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["user"]["username"], "new.person")
        self.assertTrue(created.data["user"]["username_confirmed"])

    def test_live_check_says_free_taken_or_why_not(self):
        check = lambda name, **extra: self.client.post("/api/auth/check-username/", {"username": name, **extra}, format="json").data  # noqa: E731
        self.assertTrue(check("brand.new")["ok"])
        taken = check("@KAIMIN")
        self.assertFalse(taken["ok"])
        self.assertEqual(taken["suggestion"], "kaimin2")
        self.assertIn("at least", check("ab")["message"])
        # Your own username is fine for you.
        self.client.force_authenticate(self.kai)
        self.assertTrue(check("kaimin")["ok"])

    # --- profile and the "choose your username" step ---------------------------

    def test_keeping_or_changing_it_confirms_it_and_names_stay_required(self):
        self.client.force_authenticate(self.kai)
        self.assertFalse(self.client.get("/api/auth/me/").data["username_confirmed"])
        kept = self.client.patch("/api/auth/me/", {"username": "kaimin"}, format="json")
        self.assertTrue(kept.data["username_confirmed"])
        changed = self.client.patch("/api/auth/me/", {"username": "Kai.M"}, format="json")
        self.assertEqual(changed.data["username"], "kai.m")
        User.objects.create_user("other@example.com", PASSWORD, full_name="Other", username="taken.one")
        self.assertIn("taken", self.client.patch("/api/auth/me/", {"username": "taken.one"}, format="json").data["username"][0])
        self.assertIn("full_name", self.client.patch("/api/auth/me/", {"full_name": "  "}, format="json").data)

    # --- finding people ---------------------------------------------------------------

    def test_search_by_username_and_results_show_it(self):
        me = User.objects.create_user("me@example.com", PASSWORD, full_name="Me Myself", email_verified_at=timezone.now())
        other_kai = User.objects.create_user("kai.b@example.com", PASSWORD, full_name="Kai Min", username="kai.b")
        Friendship.objects.create(requester=me, addressee=self.kai, status=Friendship.Status.ACCEPTED)
        self.client.force_authenticate(me)
        search = lambda q: self.client.get("/api/social/users/", {"q": q}).data  # noqa: E731

        # Two people called "Kai Min": the username tells them apart.
        by_name = search("Kai Min")
        self.assertEqual({p["username"] for p in by_name}, {"kaimin", "kai.b"})
        self.assertEqual([p["username"] for p in search("@kai.b")], ["kai.b"])
        # An exact username comes first.
        self.assertEqual(search("kai.b")[0]["id"], other_kai.pk)
        self.assertEqual(search("@k")[:1], [])  # too short
        friends = self.client.get("/api/social/friends/").data["friends"]
        self.assertEqual(friends[0]["username"], "kaimin")
