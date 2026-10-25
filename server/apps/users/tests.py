from django.utils import timezone
from django.conf import settings
from django.core.cache import cache
from rest_framework.test import APITestCase

from . import otp
from .models import TrustedDevice, User

PASSWORD = "Sunny-Clock-2026"
ORIGIN = "http://localhost:5173"


class AuthTests(APITestCase):
    def setUp(self):
        cache.clear()  # login/register throttles
        self.user = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=timezone.now())
        # This test browser is one Mia already trusts, so logins skip the email code (see test_otp).
        TrustedDevice.objects.create(user=self.user, token_hash=otp._hash("known-device"))
        self.client.cookies[settings.TRUSTED_DEVICE_COOKIE] = "known-device"

    def login(self, password=PASSWORD, **extra):
        return self.client.post("/api/auth/login/", {"email": "MIA@example.com", "password": password}, format="json", **extra)

    def test_register_creates_user_and_session(self):
        response = self.client.post(
            "/api/auth/register/",
            {"full_name": " Ko Aung ", "email": "Aung@Example.com", "password": PASSWORD, "timezone": "Asia/Yangon"},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertIn("access", response.data)
        self.assertEqual(response.data["user"]["email"], "aung@example.com")
        self.assertEqual(response.data["user"]["full_name"], "Ko Aung")
        self.assertEqual(response.data["user"]["tutorial_seen"], False)
        cookie = response.cookies[settings.REFRESH_COOKIE_NAME]
        self.assertTrue(cookie["httponly"])
        self.assertEqual(cookie["path"], "/api/auth/")

    def test_register_rejects_weak_password_duplicate_email_and_bad_timezone(self):
        weak = self.client.post("/api/auth/register/", {"full_name": "A", "email": "a@example.com", "password": "short"}, format="json")
        self.assertEqual(weak.status_code, 400)
        self.assertIn("non_field_errors", weak.data)

        dupe = self.client.post(
            "/api/auth/register/", {"full_name": "A", "email": "MIA@example.com", "password": PASSWORD}, format="json"
        )
        self.assertIn("email", dupe.data)

        zone = self.client.post(
            "/api/auth/register/",
            {"full_name": "A", "email": "b@example.com", "password": PASSWORD, "timezone": "Mars/Base"},
            format="json",
        )
        self.assertIn("timezone", zone.data)

    def test_login_refresh_logout_cycle(self):
        response = self.login()
        self.assertEqual(response.status_code, 200)
        access = response.data["access"]

        me = self.client.get("/api/auth/me/", HTTP_AUTHORIZATION=f"Bearer {access}")
        self.assertEqual(me.data["email"], "mia@example.com")

        refreshed = self.client.post("/api/auth/refresh/")
        self.assertEqual(refreshed.status_code, 200)
        self.assertIn("access", refreshed.data)

        cookie = self.client.cookies[settings.REFRESH_COOKIE_NAME].value
        self.assertEqual(self.client.post("/api/auth/logout/").status_code, 204)
        # The cookie is cleared (refresh now says "no session")...
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 204)
        # ...and the token itself was blacklisted, so a stolen copy is useless.
        self.client.cookies[settings.REFRESH_COOKIE_NAME] = cookie
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 401)

    def test_rotated_refresh_token_cannot_be_reused(self):
        self.login()
        old = self.client.cookies[settings.REFRESH_COOKIE_NAME].value
        self.client.post("/api/auth/refresh/")
        self.client.cookies[settings.REFRESH_COOKIE_NAME] = old
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 401)

    def test_refresh_for_deleted_account_is_a_clean_401(self):
        self.login()
        self.user.delete()
        response = self.client.post("/api/auth/refresh/")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.cookies[settings.REFRESH_COOKIE_NAME].value, "")

    def test_wrong_password_and_lockout(self):
        for _ in range(5):
            self.assertEqual(self.login("wrong").status_code, 401)
        locked = self.login()
        self.assertEqual(locked.status_code, 403)
        self.assertIn("Try again", locked.data["detail"])

    def test_unknown_email_gives_same_error(self):
        response = self.client.post("/api/auth/login/", {"email": "nobody@example.com", "password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.data["detail"], "Invalid email or password.")

    def test_foreign_origin_rejected_for_cookie_endpoints(self):
        self.assertEqual(self.login(HTTP_ORIGIN="https://evil.example").status_code, 403)
        self.assertEqual(self.login(HTTP_ORIGIN=ORIGIN).status_code, 200)
        self.assertEqual(self.client.post("/api/auth/refresh/", HTTP_ORIGIN="https://evil.example").status_code, 403)

    def test_profile_update_and_change_password(self):
        self.client.force_authenticate(self.user)
        updated = self.client.patch(
            "/api/auth/me/", {"full_name": "Mia T", "timezone": "Europe/Berlin", "tutorial_seen": True, "reminders_enabled": True}, format="json"
        )
        self.assertEqual(updated.status_code, 200, updated.data)
        self.user.refresh_from_db()
        self.assertEqual((self.user.full_name, self.user.timezone, self.user.tutorial_seen, self.user.reminders_enabled), ("Mia T", "Europe/Berlin", True, True))

        wrong = self.client.post("/api/auth/change-password/", {"old_password": "nope", "new_password": "Another-Clock-2026"}, format="json")
        self.assertIn("old_password", wrong.data)
        ok = self.client.post("/api/auth/change-password/", {"old_password": PASSWORD, "new_password": "Another-Clock-2026"}, format="json")
        self.assertEqual(ok.status_code, 204)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("Another-Clock-2026"))

    def test_delete_account_needs_password_then_hides_everything(self):
        from apps.notifications.models import PushSubscription
        from apps.tasks.models import Task

        from .models import AuthEvent

        login = self.login()
        access = login.data["access"]
        cookie = self.client.cookies[settings.REFRESH_COOKIE_NAME].value
        Task.objects.create(owner=self.user, title="mine")
        PushSubscription.objects.create(user=self.user, endpoint="https://push.example.com/x", p256dh="k", auth="a")
        other = User.objects.create_user("aung@example.com", PASSWORD, email_verified_at=timezone.now())
        Task.objects.create(owner=other, title="theirs")

        auth = {"HTTP_AUTHORIZATION": f"Bearer {access}"}
        wrong = self.client.delete("/api/auth/me/", {"password": "nope"}, format="json", **auth)
        self.assertEqual(wrong.status_code, 400)
        self.assertIn("password", wrong.data)
        self.assertTrue(User.objects.filter(pk=self.user.pk).exists())

        deleted = self.client.delete("/api/auth/me/", {"password": PASSWORD}, format="json", **auth)
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual(deleted.cookies[settings.REFRESH_COOKIE_NAME].value, "")
        # Soft delete: gone for the app, still in the database (restorable), tasks kept.
        self.assertFalse(User.objects.filter(pk=self.user.pk).exists())
        self.assertIsNotNone(User.all_objects.get(pk=self.user.pk).deleted_at)
        self.assertEqual(Task.objects.filter(owner_id=self.user.pk).count(), 1)
        self.assertFalse(PushSubscription.objects.exists())
        self.assertTrue(AuthEvent.objects.filter(user_id=self.user.pk, kind="deleted").exists())

        # Old tokens are dead and the email can't log in.
        self.assertEqual(self.client.get("/api/tasks/", **auth).status_code, 401)
        self.client.cookies[settings.REFRESH_COOKIE_NAME] = cookie
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 401)
        # Logging in now only offers to restore it.
        offer = self.login()
        self.assertEqual(offer.status_code, 200)
        self.assertTrue(offer.data["account_deleted"])
        self.assertNotIn("access", offer.data)

    def test_endpoints_require_login(self):
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 401)
        self.assertEqual(self.client.get("/api/tasks/").status_code, 401)
