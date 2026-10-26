import re
from datetime import timedelta
from unittest import mock

from django.conf import settings
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from . import email_check
from .models import AuthEvent, EmailCode, TrustedDevice, User

PASSWORD = "Sunny-Clock-2026"
SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15"


def last_code():
    return re.search(r"\b(\d{6})\b", mail.outbox[-1].subject).group(1)


@override_settings(EMAIL_SEND_ASYNC=False)
class EmailVerificationTests(APITestCase):
    def setUp(self):
        cache.clear()

    def register(self, email="aung@example.com"):
        return self.client.post("/api/auth/register/", {"full_name": "Ko Aung", "username": email.partition("@")[0].replace("+", "_"), "email": email, "password": PASSWORD}, format="json")

    def test_sign_up_sends_a_code_and_the_app_waits_for_it(self):
        response = self.register()
        self.assertEqual(response.status_code, 201, response.data)
        self.assertFalse(response.data["user"]["email_verified"])
        self.assertEqual(mail.outbox[-1].to, ["aung@example.com"])
        self.assertIn(settings.TRUSTED_DEVICE_COOKIE, response.cookies)
        stored = EmailCode.objects.get()
        self.assertNotIn(last_code(), stored.code_hash)  # only a hash is kept

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        self.assertEqual(self.client.get("/api/tasks/").status_code, 403)
        self.assertEqual(self.client.get("/api/auth/me/").status_code, 200)

        wrong = self.client.post("/api/auth/verify-email/", {"code": "000000" if last_code() != "000000" else "111111"}, format="json")
        self.assertEqual(wrong.status_code, 400)
        self.assertIn("4 tries left", wrong.data["code"][0])

        ok = self.client.post("/api/auth/verify-email/", {"code": last_code()}, format="json")
        self.assertEqual(ok.status_code, 200, ok.data)
        self.assertTrue(ok.data["email_verified"])
        self.assertEqual(self.client.get("/api/tasks/").status_code, 200)

    def test_resend_waits_and_old_codes_stop_working(self):
        access = self.register().data["access"]
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
        first = last_code()
        self.assertEqual(self.client.post("/api/auth/verify-email/resend/").status_code, 400)  # too soon
        EmailCode.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        self.assertEqual(self.client.post("/api/auth/verify-email/resend/").status_code, 200)
        second = last_code()
        if first != second:
            self.assertEqual(self.client.post("/api/auth/verify-email/", {"code": first}, format="json").status_code, 400)
        self.assertEqual(self.client.post("/api/auth/verify-email/", {"code": second}, format="json").status_code, 200)

    def test_too_many_wrong_tries_and_expiry(self):
        access = self.register().data["access"]
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {access}")
        good = last_code()
        bad = "000000" if good != "000000" else "111111"
        for _ in range(5):
            self.client.post("/api/auth/verify-email/", {"code": bad}, format="json")
        locked = self.client.post("/api/auth/verify-email/", {"code": good}, format="json")
        self.assertEqual(locked.status_code, 400)

        EmailCode.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        self.client.post("/api/auth/verify-email/resend/")
        EmailCode.objects.filter(used_at__isnull=True).update(expires_at=timezone.now() - timedelta(seconds=1))
        expired = self.client.post("/api/auth/verify-email/", {"code": last_code()}, format="json")
        self.assertIn("expired", expired.data["code"][0])

    def test_changing_email_needs_a_new_code(self):
        user = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())
        self.client.force_authenticate(user)
        response = self.client.patch("/api/auth/me/", {"email": "mia.new@example.com"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(response.data["email_verified"])
        self.assertEqual(mail.outbox[-1].to, ["mia.new@example.com"])


@override_settings(EMAIL_SEND_ASYNC=False)
class NewDeviceTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())

    def login(self):
        return self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json", HTTP_USER_AGENT=SAFARI)

    def test_new_browser_needs_the_emailed_code_then_is_remembered(self):
        first = self.login()
        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.data["two_factor_required"])
        self.assertNotIn("access", first.data)
        self.assertNotIn(settings.REFRESH_COOKIE_NAME, first.cookies)
        self.assertEqual(first.data["email"], "mi•••@example.com")
        self.assertIn("Safari on macOS", mail.outbox[-1].body)
        self.assertFalse(AuthEvent.objects.filter(kind="login").exists())

        verified = self.client.post("/api/auth/login/verify/", {"challenge": first.data["challenge"], "code": last_code()}, format="json", HTTP_USER_AGENT=SAFARI)
        self.assertEqual(verified.status_code, 200, verified.data)
        self.assertIn("access", verified.data)
        self.assertTrue(verified.cookies[settings.TRUSTED_DEVICE_COOKIE]["httponly"])
        self.assertTrue(AuthEvent.objects.filter(kind="login").exists())

        again = self.login()  # same browser, cookie now set
        self.assertIn("access", again.data)

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {again.data['access']}")
        devices = self.client.get("/api/auth/devices/").data
        self.assertEqual(len(devices), 1)
        self.assertTrue(devices[0]["current"])
        self.assertEqual(devices[0]["name"], "Safari on macOS")
        self.assertEqual(self.client.delete(f"/api/auth/devices/{devices[0]['id']}/").status_code, 204)
        self.client.credentials()
        r = self.login()
        self.assertTrue(r.data.get("two_factor_required"), (r.status_code, r.data))
        # Pressing Log in again straight away reuses the code that was just sent.
        sent = len(mail.outbox)
        retry = self.login().data
        self.assertEqual(len(mail.outbox), sent)
        ok = self.client.post("/api/auth/login/verify/", {"challenge": retry["challenge"], "code": last_code()}, format="json")
        self.assertEqual(ok.status_code, 200, ok.data)

    def test_code_is_tied_to_its_sign_in_attempt_and_challenge_is_signed(self):
        first = self.login().data
        code = last_code()
        EmailCode.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        second = self.login().data  # a second attempt makes the first code useless
        stale = self.client.post("/api/auth/login/verify/", {"challenge": first["challenge"], "code": code}, format="json")
        self.assertEqual(stale.status_code, 400)
        forged = self.client.post("/api/auth/login/verify/", {"challenge": second["challenge"] + "x", "code": last_code()}, format="json")
        self.assertEqual(forged.status_code, 400)
        self.assertIn("expired", forged.data["detail"])
        self.assertEqual(TrustedDevice.objects.count(), 0)

    def test_banned_or_locked_rules_still_come_first(self):
        self.user.is_active = False
        self.user.banned_at = timezone.now()
        self.user.save()
        self.assertEqual(self.login().status_code, 403)
        self.assertEqual(len(mail.outbox), 0)


class EmailCheckTests(APITestCase):
    def setUp(self):
        cache.clear()

    def check(self, email):
        return self.client.post("/api/auth/check-email/", {"email": email}, format="json").data

    @override_settings(EMAIL_ALLOW_RESERVED_DOMAINS=False)
    def test_format_disposable_typo_and_dns(self):
        self.assertFalse(self.check("not-an-email")["ok"])
        self.assertFalse(self.check("a@mailinator.com")["ok"])
        self.assertEqual(self.check("a@mailinator.com")["checks"], {"format": True, "real_inbox": False, "receives_mail": None})
        self.assertEqual(self.check("nope")["checks"]["format"], False)
        with mock.patch.object(email_check, "domain_accepts_mail", return_value=False):
            typo = self.check("mia@gmial.com")
        self.assertFalse(typo["ok"])
        self.assertEqual(typo["suggestion"], "mia@gmail.com")
        with mock.patch.object(email_check, "domain_accepts_mail", return_value=True):
            self.assertTrue(self.check("mia@gmail.com")["ok"])
            self.assertIsNone(self.check("mia@gmail.com")["suggestion"])

    @override_settings(EMAIL_ALLOW_RESERVED_DOMAINS=False)
    def test_sign_up_rejects_a_domain_without_mail(self):
        with mock.patch.object(email_check, "domain_accepts_mail", return_value=False):
            response = self.client.post("/api/auth/register/", {"full_name": "A", "username": "auser", "email": "a@nowhere-mail.invalid", "password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("can't receive email", response.data["email"][0])


class PruneTests(APITestCase):
    def test_prune_deletes_only_old_rows(self):
        from apps.users.cleanup import prune

        user = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())
        now = timezone.now()
        EmailCode.objects.create(user=user, purpose="verify", code_hash="x", expires_at=now - timedelta(days=2))
        EmailCode.objects.create(user=user, purpose="verify", code_hash="y", expires_at=now + timedelta(minutes=5))
        old = AuthEvent.objects.create(user=user, email=user.email, kind="login")
        AuthEvent.objects.filter(pk=old.pk).update(created_at=now - timedelta(days=200))
        AuthEvent.objects.create(user=user, email=user.email, kind="login")
        counts = prune(now)
        self.assertEqual(counts["email_codes"], 1)
        self.assertEqual(counts["auth_events"], 1)
        self.assertEqual(EmailCode.objects.count(), 1)
        self.assertEqual(AuthEvent.objects.count(), 1)

    @override_settings(CRON_SECRET="s3cret")
    def test_cron_endpoint_needs_the_secret(self):
        self.assertEqual(self.client.post("/api/cron/prune/").status_code, 403)
        self.assertEqual(self.client.post("/api/cron/prune/", HTTP_X_CRON_SECRET="s3cret").status_code, 200)


@override_settings(EMAIL_SEND_ASYNC=False)
class WelcomeEmailTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_sent_once_after_sign_up_is_confirmed(self):
        response = self.client.post("/api/auth/register/", {"full_name": "Ko Aung", "username": "aung", "email": "aung@example.com", "password": PASSWORD}, format="json")
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        self.assertFalse(any("Welcome" in m.subject for m in mail.outbox))  # not before the email is confirmed
        self.client.post("/api/auth/verify-email/", {"code": last_code()}, format="json")
        welcome = [m for m in mail.outbox if "Welcome" in m.subject]
        self.assertEqual(len(welcome), 1)
        self.assertIn("Welcome to To-Do, Ko!", welcome[0].body)
        html = welcome[0].alternatives[0][0]
        self.assertIn("Open To-Do", html)
        self.assertNotIn("{{", html)
        # Later logins don't send it again.
        self.client.credentials()
        self.client.post("/api/auth/logout/")
        self.client.post("/api/auth/login/", {"email": "aung@example.com", "password": PASSWORD}, format="json")
        self.assertEqual(len([m for m in mail.outbox if "Welcome" in m.subject]), 1)

    def test_existing_verified_account_gets_it_at_next_login(self):
        User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=timezone.now())
        first = self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json")
        self.assertTrue(first.data["two_factor_required"])
        self.assertFalse(any("Welcome" in m.subject for m in mail.outbox))  # only once actually signed in
        self.client.post("/api/auth/login/verify/", {"challenge": first.data["challenge"], "code": last_code()}, format="json")
        self.assertEqual(len([m for m in mail.outbox if "Welcome" in m.subject]), 1)

    def test_code_email_is_designed_and_has_a_text_part(self):
        self.client.post("/api/auth/register/", {"full_name": "A", "username": "auser", "email": "a@example.com", "password": PASSWORD}, format="json")
        message = mail.outbox[-1]
        self.assertIn(last_code(), message.body)
        html = message.alternatives[0][0]
        self.assertIn("Confirm your email", html)
        self.assertIn(last_code(), html)
        self.assertNotIn("<a ", html)  # code emails have no clickable links (only icon images)


@override_settings(EMAIL_SEND_ASYNC=False)
class CodeExpiryTests(APITestCase):
    def setUp(self):
        cache.clear()

    def test_app_gets_the_expiry_time_for_its_countdown(self):
        created = self.client.post("/api/auth/register/", {"full_name": "A", "username": "auser", "email": "a@example.com", "password": PASSWORD}, format="json")
        expires = created.data["user"]["code_expires_at"]
        self.assertIsNotNone(expires)
        left = (EmailCode.objects.get().expires_at - timezone.now()).total_seconds()
        self.assertTrue(9 * 60 < left <= 10 * 60)

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {created.data['access']}")
        EmailCode.objects.update(created_at=timezone.now() - timedelta(minutes=2))
        resent = self.client.post("/api/auth/verify-email/resend/")
        self.assertIn("expires_at", resent.data)
        self.client.post("/api/auth/verify-email/", {"code": last_code()}, format="json")
        self.assertIsNone(self.client.get("/api/auth/me/").data["code_expires_at"])  # verified: nothing pending

    def test_new_device_sign_in_includes_it(self):
        User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())
        step = self.client.post("/api/auth/login/", {"email": "mia@example.com", "password": PASSWORD}, format="json").data
        self.assertIsNotNone(step["expires_at"])
