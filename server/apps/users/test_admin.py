from django.conf import settings
from django.core.cache import cache
from rest_framework.test import APITestCase

from apps.tasks.models import Task

from .models import AuthEvent, User

PASSWORD = "Sunny-Clock-2026"


class AuthEventLogTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_signup_login_logout_are_logged_and_only_login_keeps_ip(self):
        self.client.post(
            "/api/auth/register/", {"full_name": "Mia", "username": "mia", "email": "mia@example.com", "password": PASSWORD}, format="json", REMOTE_ADDR="10.0.0.1"
        )
        self.client.post("/api/auth/logout/")
        self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json", REMOTE_ADDR="10.0.0.2")
        self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": "wrong"}, format="json", REMOTE_ADDR="10.0.0.3")

        events = list(AuthEvent.objects.order_by("id").values_list("kind", "ip_address", "email"))
        self.assertEqual(
            events,
            [
                ("signup", None, "mia@example.com"),
                ("login", "10.0.0.1", "mia@example.com"),  # signing up logs you in
                ("logout", None, "mia@example.com"),
                ("login", "10.0.0.2", "mia@example.com"),
            ],
        )

    def test_sign_up_counts_as_first_login(self):
        self.client.post("/api/auth/register/", {"full_name": "Mia", "username": "mia", "email": "mia@example.com", "password": PASSWORD}, format="json", REMOTE_ADDR="10.0.0.9")
        user = User.objects.get(email="mia@example.com")
        self.assertIsNotNone(user.last_login_at)
        self.assertEqual(user.last_login_ip, "10.0.0.9")

    def test_forwarded_ip_is_used(self):
        User.objects.create_user("mia@example.com", PASSWORD)
        self.client.post(
            "/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json", HTTP_X_FORWARDED_FOR="203.0.113.9, 10.0.0.1"
        )
        self.assertEqual(AuthEvent.objects.get().ip_address, "203.0.113.9")


class AdminApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user("admin@example.com", PASSWORD, is_staff=True)
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia")
        Task.objects.create(owner=self.mia, title="a")
        Task.objects.create(owner=self.mia, title="b")
        self.client.force_authenticate(self.admin)

    def test_regular_users_are_forbidden(self):
        self.client.force_authenticate(self.mia)
        for path in ["/api/admin/stats/", "/api/admin/users/", f"/api/admin/users/{self.mia.id}/", "/api/admin/auth-events/"]:
            self.assertEqual(self.client.get(path).status_code, 403, path)
        self.assertEqual(self.client.post(f"/api/admin/users/{self.admin.id}/ban/").status_code, 403)

    def test_stats_and_user_list(self):
        stats = self.client.get("/api/admin/stats/").data
        self.assertEqual((stats["total_users"], stats["active_users"], stats["banned_users"]), (2, 2, 0))

        listed = self.client.get("/api/admin/users/", {"search": "mia"}).data
        self.assertEqual(listed["count"], 1)
        row = listed["results"][0]
        self.assertEqual((row["email"], row["task_count"], row["status"]), ("mia@example.com", 2, "active"))
        self.assertNotIn("password", row)

    def test_user_detail_includes_events(self):
        AuthEvent.objects.create(user=self.mia, email=self.mia.email, kind="login", ip_address="10.0.0.2")
        detail = self.client.get(f"/api/admin/users/{self.mia.id}/").data
        self.assertEqual(detail["recent_events"][0]["ip_address"], "10.0.0.2")

    def test_ban_ends_sessions_and_blocks_login_then_unban_restores(self):
        self.client.force_authenticate(None)
        login = self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json")
        access = login.data["access"]
        mia_cookie = self.client.cookies[settings.REFRESH_COOKIE_NAME].value

        self.client.force_authenticate(self.admin)
        banned = self.client.post(f"/api/admin/users/{self.mia.id}/ban/", {"reason": "Spam"}, format="json")
        self.assertEqual((banned.status_code, banned.data["status"], banned.data["ban_reason"]), (200, "banned", "Spam"))
        self.client.force_authenticate(None)

        # The existing access token stops working immediately...
        self.assertEqual(self.client.get("/api/tasks/", HTTP_AUTHORIZATION=f"Bearer {access}").status_code, 401)
        # ...the refresh token is revoked...
        self.client.cookies[settings.REFRESH_COOKIE_NAME] = mia_cookie
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 401)
        # ...and logging in again says why.
        relogin = self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json")
        self.assertEqual(relogin.status_code, 403)
        self.assertEqual(relogin.data["detail"], "This account has been suspended.")

        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.post(f"/api/admin/users/{self.mia.id}/unban/").data["status"], "active")
        self.client.force_authenticate(None)
        self.assertEqual(self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json").status_code, 200)

    def test_cannot_ban_self_or_other_admins(self):
        self.assertEqual(self.client.post(f"/api/admin/users/{self.admin.id}/ban/").status_code, 400)
        other_admin = User.objects.create_user("boss@example.com", PASSWORD, is_staff=True)
        self.assertEqual(self.client.post(f"/api/admin/users/{other_admin.id}/ban/").status_code, 403)

    def test_status_filter_and_event_list(self):
        self.client.post(f"/api/admin/users/{self.mia.id}/ban/")
        self.assertEqual(self.client.get("/api/admin/users/", {"status": "banned"}).data["count"], 1)
        AuthEvent.objects.create(user=self.mia, email=self.mia.email, kind="signup")
        self.assertEqual(self.client.get("/api/admin/auth-events/", {"kind": "signup"}).data["count"], 1)


class AdminTableTests(APITestCase):
    """Sorting, filters and paging for the Users table and the Activity log."""

    def setUp(self):
        from datetime import timedelta

        from django.utils import timezone

        self.admin = User.objects.create_user("admin@example.com", PASSWORD, is_staff=True, full_name="Zed Admin")
        self.ann = User.objects.create_user("ann@example.com", PASSWORD, full_name="Ann", email_verified_at=timezone.now())
        self.bob = User.objects.create_user("bob@example.com", PASSWORD, full_name="Bob", last_login_at=timezone.now())
        Task.objects.create(owner=self.bob, title="a")
        self.client.force_authenticate(self.admin)
        old = AuthEvent.objects.create(user=self.ann, email=self.ann.email, kind="login", ip_address="203.0.113.7")
        AuthEvent.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=10))
        AuthEvent.objects.create(user=self.bob, email=self.bob.email, kind="signup")
        AuthEvent.objects.create(user=self.bob, email=self.bob.email, kind="login", ip_address="10.0.0.5")

    def emails(self, path, **params):
        response = self.client.get(path, params)
        self.assertEqual(response.status_code, 200, response.data)
        return [row["email"] for row in response.data["results"]]

    def test_user_sorting_filters_and_page_size(self):
        self.assertEqual(self.emails("/api/admin/users/", ordering="name"), ["ann@example.com", "bob@example.com", "admin@example.com"])
        self.assertEqual(self.emails("/api/admin/users/", ordering="-tasks")[0], "bob@example.com")
        # Never logged in sorts last both ways.
        self.assertEqual(self.emails("/api/admin/users/", ordering="last_login")[0], "bob@example.com")
        self.assertEqual(self.emails("/api/admin/users/", ordering="-last_login")[0], "bob@example.com")
        self.assertEqual(self.emails("/api/admin/users/", verified="yes"), ["ann@example.com"])
        page = self.client.get("/api/admin/users/", {"page_size": 2, "page": 2, "ordering": "email"}).data
        self.assertEqual((page["count"], [r["email"] for r in page["results"]]), (3, ["bob@example.com"]))
        self.assertIn("email_verified", page["results"][0])
        self.assertEqual(self.client.get("/api/admin/users/", {"ordering": "password"}).status_code, 400)

    def test_activity_log_search_kind_since_and_sort(self):
        self.assertEqual(len(self.emails("/api/admin/auth-events/")), 3)
        self.assertEqual(self.emails("/api/admin/auth-events/", search="203.0.113"), ["ann@example.com"])
        self.assertEqual(self.emails("/api/admin/auth-events/", search="BOB@"), ["bob@example.com", "bob@example.com"])
        self.assertEqual(self.emails("/api/admin/auth-events/", kind="login", since="7d"), ["bob@example.com"])
        self.assertEqual(self.emails("/api/admin/auth-events/", ordering="time")[0], "ann@example.com")
        self.assertEqual(self.client.get("/api/admin/auth-events/", {"kind": "hack"}).status_code, 400)
