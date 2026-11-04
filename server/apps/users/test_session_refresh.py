from datetime import timedelta
from unittest import mock

from django.conf import settings
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from apps.users import services
from apps.users.models import RotatedRefresh, User

PASSWORD = "Str0ng!Passw0rd#1"
COOKIE = settings.REFRESH_COOKIE_NAME


class RefreshCollisionTests(TestCase):
    """Two tabs, a page reload or a lost connection can send the same token twice."""

    def setUp(self):
        self.user = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", username="mia_t")
        self.client = APIClient()
        self.old = str(RefreshToken.for_user(self.user))
        self.client.cookies[COOKIE] = self.old

    def resend_old(self):
        self.client.cookies[COOKIE] = self.old
        return self.client.post("/api/auth/refresh/")

    def test_second_refresh_with_the_same_token_keeps_you_signed_in(self):
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 200)
        again = self.resend_old()
        self.assertEqual(again.status_code, 200)
        self.assertIn("access", again.data)
        # The cookie that ends up in the browser is a new, working one, not a deleted one.
        self.assertTrue(again.cookies[COOKIE].value)
        self.assertNotEqual(again.cookies[COOKIE].value, self.old)
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 200)

    def test_a_lost_response_can_be_retried(self):
        self.client.post("/api/auth/refresh/")  # the answer never reached the browser
        self.assertEqual(self.resend_old().status_code, 200)

    def test_an_old_token_stops_working_after_the_grace_period(self):
        self.client.post("/api/auth/refresh/")
        later = timezone.now() + timedelta(seconds=settings.REFRESH_REUSE_SECONDS + 1)
        with mock.patch("django.utils.timezone.now", return_value=later):
            response = self.resend_old()
        self.assertEqual(response.status_code, 401)

    def test_retrying_does_not_extend_the_grace_period(self):
        self.client.post("/api/auth/refresh/")
        self.resend_old()
        later = timezone.now() + timedelta(seconds=settings.REFRESH_REUSE_SECONDS + 1)
        with mock.patch("django.utils.timezone.now", return_value=later):
            self.assertEqual(self.resend_old().status_code, 401)

    def test_logging_out_ends_the_grace_period_at_once(self):
        self.client.post("/api/auth/refresh/")
        self.assertEqual(self.client.post("/api/auth/logout/").status_code, 204)
        self.assertEqual(self.resend_old().status_code, 401)

    def test_a_logged_out_token_gets_no_grace(self):
        self.assertEqual(self.client.post("/api/auth/logout/").status_code, 204)
        self.assertEqual(self.resend_old().status_code, 401)

    def test_banning_ends_the_grace_period_at_once(self):
        self.client.post("/api/auth/refresh/")
        services.end_sessions(self.user)
        self.assertEqual(self.resend_old().status_code, 401)

    def test_a_banned_account_gets_no_grace(self):
        self.client.post("/api/auth/refresh/")
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.resend_old().status_code, 401)

    def test_an_account_erased_for_good_is_a_clean_sign_out(self):
        User.all_objects.filter(pk=self.user.pk).delete()
        self.client.cookies[COOKIE] = self.old
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 401)

    def test_a_made_up_token_is_refused(self):
        self.client.cookies[COOKIE] = "not-a-token"
        self.assertEqual(self.client.post("/api/auth/refresh/").status_code, 401)

    def test_old_records_are_tidied_away(self):
        self.client.post("/api/auth/refresh/")
        RotatedRefresh.objects.update(rotated_at=timezone.now() - timedelta(days=1))
        self.client.post("/api/auth/refresh/")
        self.assertEqual(RotatedRefresh.objects.count(), 1)
