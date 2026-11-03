from django.test import SimpleTestCase

from config.monitoring import scrub_event


class ErrorReportPrivacyTests(SimpleTestCase):
    def test_reports_keep_where_it_broke_and_nothing_private(self):
        event = {
            "exception": {"values": [{"type": "ValueError"}]},
            "user": {"id": 5, "email": "mia@example.com"},
            "breadcrumbs": {"values": [{"message": "SELECT secret"}]},
            "request": {
                "method": "POST",
                "url": "https://api.example.com/api/social/users/?q=mia",
                "headers": {"Authorization": "Bearer abc", "Cookie": "refresh=abc"},
                "cookies": {"refresh": "abc"},
                "data": {"password": "Sunny-Clock-2026", "text": "a private message"},
                "query_string": "q=mia",
            },
        }
        scrubbed = scrub_event(event)
        self.assertEqual(scrubbed["request"], {"method": "POST", "url": "https://api.example.com/api/social/users/"})
        self.assertEqual(scrubbed["exception"]["values"][0]["type"], "ValueError")
        for private in ("mia@example.com", "Bearer", "Sunny-Clock", "private message", "SELECT secret", "q=mia"):
            self.assertNotIn(private, str(scrubbed))
