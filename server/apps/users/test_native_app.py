import re

from django.conf import settings
from django.core import mail
from django.test import override_settings
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APITestCase

from . import otp
from .models import TrustedDevice, User

PASSWORD = "Sunny-Clock-2026"
APP = {"HTTP_ORIGIN": "capacitor://localhost"}


@override_settings(EMAIL_SEND_ASYNC=False)
class NativeAppSessionTests(APITestCase):
    """The iPhone app can't keep our cookies, so it gets and returns its tokens in the body."""

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=timezone.now())
        TrustedDevice.objects.create(user=self.user, token_hash=otp._hash("known-phone"))

    def login(self, **extra):
        return self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json", **extra)

    def test_the_app_gets_its_refresh_token_in_the_body_and_no_cookie(self):
        response = self.login(HTTP_X_DEVICE_TOKEN="known-phone", **APP)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn("refresh", response.data)
        self.assertNotIn(settings.REFRESH_COOKIE_NAME, response.cookies)

    def test_the_website_never_sees_the_refresh_token(self):
        self.client.cookies[settings.TRUSTED_DEVICE_COOKIE] = "known-phone"
        response = self.login(HTTP_ORIGIN="http://localhost:5173")
        self.assertNotIn("refresh", response.data)
        self.assertIn(settings.REFRESH_COOKIE_NAME, response.cookies)
        refreshed = self.client.post("/api/auth/refresh/", HTTP_ORIGIN="http://localhost:5173")
        self.assertNotIn("refresh", refreshed.data)

    def test_refresh_rotates_and_logout_ends_it(self):
        first = self.login(HTTP_X_DEVICE_TOKEN="known-phone", **APP).data["refresh"]
        refreshed = self.client.post("/api/auth/refresh/", {"refresh": first}, format="json", **APP)
        self.assertEqual(refreshed.status_code, 200)
        second = refreshed.data["refresh"]
        self.assertNotEqual(first, second)
        self.assertIn("access", refreshed.data)
        self.assertEqual(self.client.post("/api/auth/logout/", {"refresh": second}, format="json", **APP).status_code, 204)
        self.assertEqual(self.client.post("/api/auth/refresh/", {"refresh": second}, format="json", **APP).status_code, 401)

    def test_no_token_means_logged_out(self):
        self.assertEqual(self.client.post("/api/auth/refresh/", {}, format="json", **APP).status_code, 204)
        self.assertEqual(self.client.post("/api/auth/refresh/", {"refresh": 5}, format="json", **APP).status_code, 204)

    def test_the_app_ignores_cookies(self):
        self.client.cookies[settings.TRUSTED_DEVICE_COOKIE] = "known-phone"
        response = self.login(**APP)
        self.assertTrue(response.data.get("two_factor_required"))

    def test_a_new_phone_signs_in_with_the_emailed_code_and_is_remembered(self):
        challenge = self.login(**APP).data["challenge"]
        code = re.search(r"\b\d{6}\b", mail.outbox[-1].subject).group(0)
        response = self.client.post("/api/auth/login/verify/", {"challenge": challenge, "code": code}, format="json", **APP)
        self.assertEqual(response.status_code, 200, response.data)
        device = response.data["device"]
        self.assertIn("refresh", response.data)
        self.assertNotIn(settings.TRUSTED_DEVICE_COOKIE, response.cookies)
        cache.clear()
        again = self.login(HTTP_X_DEVICE_TOKEN=device, **APP)
        self.assertIn("refresh", again.data)

    def test_cors_lets_only_the_app_in(self):
        allowed = self.client.options("/api/auth/refresh/", HTTP_ORIGIN="capacitor://localhost", HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST", HTTP_ACCESS_CONTROL_REQUEST_HEADERS="content-type,x-device-token")
        self.assertEqual(allowed["access-control-allow-origin"], "capacitor://localhost")
        self.assertIn("x-device-token", allowed["access-control-allow-headers"])
        other = self.client.options("/api/auth/refresh/", HTTP_ORIGIN="https://evil.example", HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST")
        self.assertNotIn("access-control-allow-origin", other)

    def test_other_sites_are_still_refused(self):
        self.assertEqual(self.login(HTTP_ORIGIN="https://evil.example").status_code, 403)
