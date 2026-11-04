from datetime import timedelta
from unittest import mock

from django.core import mail as django_mail
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.cleanup import prune
from apps.users.models import EmailLog, User

from .digest import DAILY_LIMIT, send_due_emails
from .models import Membership, Notification, Workspace

PASSWORD = "Sunny-Clock-2026"


def person(name):
    return User.objects.create_user(f"{name}@example.com", PASSWORD, full_name=name.capitalize(), email_verified_at=timezone.now())


@override_settings(EMAIL_SEND_ASYNC=False, PUSH_SEND_ASYNC=False, APP_URL="https://todoclock.app")
class TeamNotificationTests(APITestCase):
    def setUp(self):
        self.owner, self.editor, self.viewer = person("olivia"), person("eve"), person("vera")
        self.workspace = Workspace.objects.create(name="Dev Team")
        for user, role in ((self.owner, "owner"), (self.editor, "editor"), (self.viewer, "viewer")):
            Membership.objects.create(workspace=self.workspace, user=user, role=role)
        self.client.force_authenticate(self.owner)
        self.base = f"/api/workspaces/{self.workspace.pk}"

    def table(self):
        data = self.client.post(f"{self.base}/tables/", {"title": "Bugs"}, format="json").data
        Notification.objects.all().delete()
        columns = {c["type"]: c["id"] for c in data["columns"]}
        return data["id"], columns

    def titles(self, user):
        return list(Notification.objects.filter(recipient=user).order_by("id").values_list("kind", "title", "body"))

    def later(self, minutes=3):
        return timezone.now() + timedelta(minutes=minutes)

    def test_a_new_page_or_table_tells_everyone_else(self):
        self.client.post(f"{self.base}/pages/", {"title": "Notes"}, format="json")
        self.client.post(f"{self.base}/tables/", {"title": "Bugs"}, format="json")
        expected = [("new_work", "Olivia added a page to Dev Team", "Notes"), ("new_work", "Olivia added a table to Dev Team", "Bugs")]
        self.assertEqual(self.titles(self.editor), expected)
        self.assertEqual(self.titles(self.viewer), expected)
        self.assertEqual(self.titles(self.owner), [])

    def test_a_row_counts_as_new_work_once_it_says_something(self):
        table, columns = self.table()
        url = f"{self.base}/tables/{table}/rows/"
        row = self.client.post(url, {}, format="json").data["id"]
        self.assertEqual(Notification.objects.count(), 0)
        self.client.patch(f"{url}{row}/", {"values": {columns["text"]: "  Login   broken "}}, format="json")
        self.assertEqual(self.titles(self.editor), [("new_work", "Olivia added work to Bugs", "Login broken")])
        self.client.patch(f"{url}{row}/", {"values": {columns["text"]: "Login very broken"}}, format="json")
        self.assertEqual(len(self.titles(self.editor)), 1)
        self.client.post(url, {"values": {columns["text"]: "Second"}}, format="json")
        self.assertEqual(self.titles(self.editor)[-1][2], "Second")

    def test_finishing_tells_everyone_once(self):
        table, columns = self.table()
        url = f"{self.base}/tables/{table}/rows/"
        row = self.client.post(url, {"values": {columns["text"]: "Fix it"}}, format="json").data["id"]
        Notification.objects.all().delete()
        self.client.patch(f"{url}{row}/", {"values": {columns["checkbox"]: True}}, format="json")
        self.assertEqual(self.titles(self.viewer), [("done", "Olivia finished Fix it", "Bugs")])
        self.client.patch(f"{url}{row}/", {"values": {columns["text"]: "Fix it now"}}, format="json")
        self.assertEqual(len(self.titles(self.viewer)), 1)
        self.client.patch(f"{url}{row}/", {"values": {columns["checkbox"]: False}}, format="json")
        self.assertEqual(len(self.titles(self.viewer)), 1)

    def test_a_finished_row_with_no_words_uses_its_number(self):
        table, columns = self.table()
        url = f"{self.base}/tables/{table}/rows/"
        row = self.client.post(url, {}, format="json").data["id"]
        self.client.patch(f"{url}{row}/", {"values": {columns["checkbox"]: True}}, format="json")
        self.assertEqual(self.titles(self.editor)[0][1], "Olivia finished row 1 of Bugs")

    def test_it_also_goes_to_their_phones(self):
        with mock.patch("apps.workspaces.services._notify") as notify:
            self.client.post(f"{self.base}/pages/", {"title": "Notes"}, format="json")
        self.assertEqual({call.args[0] for call in notify.call_args_list}, {self.editor, self.viewer})

    def test_updates_wait_then_go_as_one_email_per_person(self):
        self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json")
        self.client.post(f"{self.base}/pages/", {"title": "Two"}, format="json")
        django_mail.outbox.clear()
        self.assertEqual(send_due_emails(), 0)
        self.assertEqual(send_due_emails(self.later()), 2)
        self.assertEqual(sorted(m.to[0] for m in django_mail.outbox), ["eve@example.com", "vera@example.com"])
        message = django_mail.outbox[0]
        self.assertEqual(message.subject, "2 updates in Dev Team")
        self.assertIn("Olivia added a page to Dev Team", message.body)
        self.assertIn("https://todoclock.app/notifications", message.body)
        self.assertIn("Todo Clock", message.alternatives[0][0])
        self.assertEqual(send_due_emails(self.later()), 0)

    def test_one_update_links_straight_to_it(self):
        self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json")
        django_mail.outbox.clear()
        send_due_emails(self.later())
        page = Notification.objects.first().url
        self.assertEqual(django_mail.outbox[0].subject, "Olivia added a page to Dev Team")
        self.assertIn(f"https://todoclock.app{page}", django_mail.outbox[0].body)

    def test_no_email_if_already_seen_or_switched_off(self):
        User.objects.filter(pk=self.viewer.pk).update(workspace_emails=False)
        self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json")
        self.client.force_authenticate(self.editor)
        self.client.post(f"{self.base.replace(self.base, '/api/workspaces')}/notifications/read/", {"workspace": self.workspace.pk}, format="json")
        django_mail.outbox.clear()
        self.assertEqual(send_due_emails(self.later()), 0)
        self.assertEqual(django_mail.outbox, [])
        self.assertFalse(Notification.objects.filter(emailed_at__isnull=True).exists())

    def test_comments_and_mentions_stay_out_of_email(self):
        page = self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json").data["id"]
        Notification.objects.all().delete()
        self.client.post(f"{self.base}/pages/{page}/comments/", {"body": "@none hi"}, format="json")
        Notification.objects.create(recipient=self.editor, workspace=self.workspace, kind="mention", title="x", url="/")
        django_mail.outbox.clear()
        self.assertEqual(send_due_emails(self.later()), 0)

    def test_the_daily_limit_holds_updates_back(self):
        self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json")
        EmailLog.objects.bulk_create([EmailLog(kind="workspace_update", recipient="x", ok=True) for _ in range(DAILY_LIMIT)])
        django_mail.outbox.clear()
        self.assertEqual(send_due_emails(self.later()), 0)
        self.assertTrue(Notification.objects.filter(emailed_at__isnull=True).exists())

    def test_old_waiting_updates_are_dropped(self):
        self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json")
        django_mail.outbox.clear()
        self.assertEqual(send_due_emails(timezone.now() + timedelta(days=8)), 0)
        self.assertFalse(Notification.objects.filter(emailed_at__isnull=True).exists())

    def test_staff_see_sent_and_failed_not_contents(self):
        self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json")
        with mock.patch("django.core.mail.EmailMultiAlternatives.send", side_effect=[1, OSError("Mail server said no")]):
            self.assertEqual(send_due_emails(self.later()), 1)
        staff = person("sam")
        User.objects.filter(pk=staff.pk).update(is_staff=True)
        staff.refresh_from_db()
        self.client.force_authenticate(staff)
        data = self.client.get("/api/admin/emails/").data
        self.assertEqual((data["sent_24h"], data["failed_24h"]), (1, 1))
        failed = next(i for i in data["items"] if not i["ok"])
        self.assertEqual(failed["kind"], "workspace_update")
        self.assertEqual(failed["error"], "Mail server said no")
        self.assertNotIn("example.com", failed["recipient"].split("@")[0])
        self.assertNotIn("eve@", str(data))
        self.assertNotIn("vera@", str(data))

    def test_only_staff_can_read_email_results(self):
        self.assertEqual(self.client.get("/api/admin/emails/").status_code, 403)

    def test_old_results_are_cleaned_up(self):
        entry = EmailLog.objects.create(kind="code", recipient="x", ok=True)
        EmailLog.objects.filter(pk=entry.pk).update(created_at=timezone.now() - timedelta(days=31))
        prune()
        self.assertFalse(EmailLog.objects.exists())

    def test_workspace_counts_and_clearing_them(self):
        other = Workspace.objects.create(name="Other")
        Membership.objects.create(workspace=other, user=self.editor, role="owner")
        Notification.objects.create(recipient=self.editor, workspace=other, kind="mention", title="x", url="/")
        self.client.post(f"{self.base}/pages/", {"title": "One"}, format="json")
        self.client.post(f"{self.base}/pages/", {"title": "Two"}, format="json")
        self.client.force_authenticate(self.editor)
        counts = {w["name"]: w["unread"] for w in self.client.get("/api/workspaces/").data["workspaces"]}
        self.assertEqual(counts, {"Dev Team": 2, "Other": 1})
        self.assertEqual(self.client.post("/api/workspaces/notifications/read/", {"workspace": "x"}, format="json").status_code, 400)
        self.client.post("/api/workspaces/notifications/read/", {"workspace": self.workspace.pk}, format="json")
        counts = {w["name"]: w["unread"] for w in self.client.get("/api/workspaces/").data["workspaces"]}
        self.assertEqual(counts, {"Dev Team": 0, "Other": 1})

    def test_the_email_setting_can_be_changed(self):
        self.assertTrue(self.client.get("/api/auth/me/").data["workspace_emails"])
        self.assertFalse(self.client.patch("/api/auth/me/", {"workspace_emails": False}, format="json").data["workspace_emails"])
