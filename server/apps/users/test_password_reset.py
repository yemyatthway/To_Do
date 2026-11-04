import re
from datetime import timedelta
from unittest import mock

from django.conf import settings
from django.core import mail as outbox
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from apps.users import otp
from apps.users.models import AuthEvent, EmailCode, TrustedDevice, User

OLD = "Sunny-Clock-2026!"
NEW = "Rainy-Window-2031!"
ORIGIN = "http://localhost:5173"
COOKIE = settings.REFRESH_COOKIE_NAME


@override_settings(EMAIL_SEND_ASYNC=False)
class PasswordResetTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user("mia@example.com", OLD, full_name="Mia", email_verified_at=timezone.now())
        self.client.defaults["HTTP_ORIGIN"] = ORIGIN

    def forgot(self, email="mia@example.com"):
        return self.client.post("/api/auth/password/forgot/", {"email": email}, format="json")

    def sent_code(self):
        return re.search(r"\b\d{6}\b", outbox.outbox[-1].subject).group(0)

    def ticket(self):
        self.forgot()
        return self.client.post("/api/auth/password/code/", {"email": "mia@example.com", "code": self.sent_code()}, format="json").data["ticket"]

    def reset(self, ticket, password=NEW):
        return self.client.post("/api/auth/password/reset/", {"ticket": ticket, "password": password}, format="json")

    def test_the_whole_way_through_signs_you_in_with_the_new_password(self):
        response = self.reset(self.ticket())
        self.assertEqual(response.status_code, 200)
        self.assertIn("access", response.data)
        self.assertTrue(response.cookies[COOKIE].value)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password(NEW))
        self.assertFalse(self.user.check_password(OLD))
        self.assertTrue(AuthEvent.objects.filter(user=self.user, kind="password").exists())

    def test_the_answer_never_says_whether_an_account_exists(self):
        known, unknown = self.forgot(), self.forgot("nobody@example.com")
        self.assertEqual(known.status_code, unknown.status_code)
        self.assertEqual(set(known.data), set(unknown.data))
        self.assertEqual(known.data["resend_in"], unknown.data["resend_in"])
        # Asking again straight away looks the same too.
        self.assertEqual(self.forgot().data["resend_in"], unknown.data["resend_in"])

    def test_only_a_real_account_gets_an_email(self):
        self.forgot("nobody@example.com")
        self.assertEqual(len(outbox.outbox), 0)
        self.forgot()
        self.assertEqual(outbox.outbox[-1].to, ["mia@example.com"])

    def test_a_wrong_code_reads_the_same_with_or_without_an_account(self):
        self.forgot()
        known = self.client.post("/api/auth/password/code/", {"email": "mia@example.com", "code": "000000"}, format="json")
        unknown = self.client.post("/api/auth/password/code/", {"email": "nobody@example.com", "code": "000000"}, format="json")
        self.assertEqual(known.status_code, 400)
        self.assertEqual(known.data, unknown.data)

    def test_too_many_wrong_codes_kills_that_code(self):
        self.forgot()
        code = self.sent_code()
        for _ in range(settings.OTP_MAX_ATTEMPTS + 1):
            self.client.post("/api/auth/password/code/", {"email": "mia@example.com", "code": "000000"}, format="json")
        right = self.client.post("/api/auth/password/code/", {"email": "mia@example.com", "code": code}, format="json")
        self.assertEqual(right.status_code, 400)

    def test_a_code_only_works_once(self):
        self.forgot()
        code = self.sent_code()
        body = {"email": "mia@example.com", "code": code}
        self.assertEqual(self.client.post("/api/auth/password/code/", body, format="json").status_code, 200)
        self.assertEqual(self.client.post("/api/auth/password/code/", body, format="json").status_code, 400)

    def test_an_expired_code_is_refused(self):
        self.forgot()
        code = self.sent_code()
        EmailCode.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.client.post("/api/auth/password/code/", {"email": "mia@example.com", "code": code}, format="json").status_code, 400)

    def test_a_code_for_signing_in_cannot_reset_a_password(self):
        otp.issue_code(self.user, EmailCode.Purpose.LOGIN, challenge="abc")
        self.assertEqual(self.client.post("/api/auth/password/code/", {"email": "mia@example.com", "code": self.sent_code()}, format="json").status_code, 400)

    def test_a_ticket_only_works_once(self):
        ticket = self.ticket()
        self.assertEqual(self.reset(ticket).status_code, 200)
        self.assertEqual(self.reset(ticket, "Another-Good-One-77!").status_code, 400)

    def test_a_made_up_ticket_is_refused(self):
        self.assertEqual(self.reset("nonsense").status_code, 400)

    def test_a_weak_password_is_refused_and_the_ticket_still_works(self):
        ticket = self.ticket()
        response = self.reset(ticket, "short")
        self.assertEqual(response.status_code, 400)
        self.assertIn("password", response.data)
        self.assertEqual(self.reset(ticket).status_code, 200)

    def test_every_other_device_is_logged_out_and_forgotten(self):
        other = str(RefreshToken.for_user(self.user))
        TrustedDevice.objects.create(user=self.user, token_hash="x" * 64, name="Old phone")
        self.reset(self.ticket())
        self.assertFalse(TrustedDevice.objects.filter(token_hash="x" * 64).exists())
        stranger = self.client_class()
        stranger.defaults["HTTP_ORIGIN"] = ORIGIN
        stranger.cookies[COOKIE] = other
        self.assertEqual(stranger.post("/api/auth/refresh/").status_code, 401)

    def test_an_email_says_the_password_changed(self):
        self.reset(self.ticket())
        self.assertEqual(outbox.outbox[-1].subject, "Your Todo Clock password was changed")
        self.assertEqual(outbox.outbox[-1].to, ["mia@example.com"])

    def test_the_new_password_logs_in_and_the_old_does_not(self):
        self.reset(self.ticket())
        self.assertEqual(self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": OLD}, format="json").status_code, 401)
        self.assertEqual(self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": NEW}, format="json").status_code, 200)

    def test_it_clears_a_lock_from_wrong_guesses(self):
        User.objects.filter(pk=self.user.pk).update(failed_login_count=9, locked_until=timezone.now() + timedelta(minutes=10))
        self.reset(self.ticket())
        self.user.refresh_from_db()
        self.assertEqual(self.user.failed_login_count, 0)
        self.assertIsNone(self.user.locked_until)

    def test_a_banned_account_gets_nothing(self):
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.forgot().status_code, 200)
        self.assertEqual(len(outbox.outbox), 0)

    def test_the_email_arrives_in_their_language(self):
        User.objects.filter(pk=self.user.pk).update(language="my")
        self.forgot()
        self.assertIn("စကားဝှက်", outbox.outbox[-1].subject)

    def test_only_our_own_site_can_ask(self):
        self.client.defaults["HTTP_ORIGIN"] = "https://evil.example"
        self.assertEqual(self.forgot().status_code, 403)
