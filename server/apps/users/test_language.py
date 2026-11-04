from django.core import mail as outbox
from django.test import TestCase
from rest_framework.test import APIClient

from apps.users import mail
from apps.users.language import BURMESE, tr
from apps.users.models import User


class LanguageTests(TestCase):
    def test_english_is_the_default_and_values_fill_in(self):
        self.assertEqual(tr("en", "{name} wants to be friends.", name="Mia"), "Mia wants to be friends.")
        self.assertEqual(tr("my", "{name} wants to be friends.", name="Mia"), BURMESE["{name} wants to be friends."].format(name="Mia"))

    def test_text_without_a_translation_stays_english(self):
        self.assertEqual(tr("my", "Something new"), "Something new")

    def test_every_translation_keeps_its_blanks(self):
        import string

        for english, burmese in BURMESE.items():
            blanks = {name for _, name, _, _ in string.Formatter().parse(english) if name}
            used = {name for _, name, _, _ in string.Formatter().parse(burmese) if name}
            self.assertLessEqual(used, blanks, english)

    def test_code_email_follows_the_language(self):
        mail.send_code(to="a@example.test", purpose="login", code="123456", language="my")
        sent = outbox.outbox[-1]
        self.assertIn(BURMESE["Your sign-in code"], sent.alternatives[0][0])
        self.assertIn("123456", sent.subject)
        self.assertNotIn("Only the newest code works", sent.body)

    def test_the_account_remembers_the_language(self):
        user = User.objects.create_user(email="a@example.test", password="Str0ng!Passw0rd", full_name="A", username="aa")
        client = APIClient()
        client.force_authenticate(user)
        self.assertEqual(client.get("/api/auth/me/").data["language"], "en")
        self.assertEqual(client.patch("/api/auth/me/", {"language": "my"}, format="json").data["language"], "my")
        self.assertEqual(client.patch("/api/auth/me/", {"language": "fr"}, format="json").status_code, 400)
