import json
from unittest import mock

from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.models import User

from .models import Membership, Page, Table, Workspace

PASSWORD = "Sunny-Clock-2026"


def person(name):
    return User.objects.create_user(f"{name}@example.com", PASSWORD, full_name=name.capitalize(), email_verified_at=timezone.now())


@override_settings(ABLY_API_KEY="name:secret", LIVE_SEND_ASYNC=False)
class LiveEditingTests(APITestCase):
    def setUp(self):
        self.owner, self.editor, self.viewer, self.outsider = person("olivia"), person("eve"), person("vera"), person("otto")
        self.workspace = Workspace.objects.create(name="Dev Team")
        for user, role in ((self.owner, "owner"), (self.editor, "editor"), (self.viewer, "viewer")):
            Membership.objects.create(workspace=self.workspace, user=user, role=role)
        self.base = f"/api/workspaces/{self.workspace.pk}"
        self.channel = f"workspace:{self.workspace.pk}"
        self.client.force_authenticate(self.owner)
        patcher = mock.patch("apps.live.ably._post")
        self.post = patcher.start()
        self.addCleanup(patcher.stop)

    def sent(self, call):
        """What this request told open apps, once it was really saved."""
        self.post.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            response = call()
        return response, [(c.args[1], c.args[2]) for c in self.post.call_args_list if c.args[0] == self.channel]

    def test_a_saved_page_goes_to_everyone_with_it_open(self):
        page = Page.objects.create(workspace=self.workspace, title="Notes")
        response, events = self.sent(lambda: self.client.patch(f"{self.base}/pages/{page.pk}/", {"base_version": page.version, "blocks": [{"id": "a", "type": "p", "text": "hello"}]}, format="json"))
        self.assertEqual(response.status_code, 200)
        name, data = events[0]
        self.assertEqual(name, "page")
        self.assertEqual((data["id"], data["version"], data["by"]), (page.pk, page.version + 1, self.owner.pk))
        self.assertEqual(data["blocks"][0]["text"], "hello")
        self.assertEqual(data["title"], "Notes")

    def test_a_page_too_big_for_a_message_only_says_it_changed(self):
        page = Page.objects.create(workspace=self.workspace, title="Notes")
        blocks = [{"id": str(i), "type": "p", "text": "x" * 9000} for i in range(6)]
        response, events = self.sent(lambda: self.client.patch(f"{self.base}/pages/{page.pk}/", {"base_version": page.version, "blocks": blocks}, format="json"))
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("blocks", events[0][1])
        self.assertEqual(events[0][1]["version"], page.version + 1)

    def test_a_refused_save_tells_nobody(self):
        page = Page.objects.create(workspace=self.workspace, title="Notes")
        response, events = self.sent(lambda: self.client.patch(f"{self.base}/pages/{page.pk}/", {"base_version": page.version + 5, "blocks": []}, format="json"))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(events, [])

    def table_with_row(self):
        table = self.client.post(f"{self.base}/tables/", {"title": "Bugs"}, format="json").data
        row = self.client.post(f"{self.base}/tables/{table['id']}/rows/", {}, format="json").data
        return table, row

    def test_a_saved_cell_goes_out_with_its_new_value_and_version(self):
        table, row = self.table_with_row()
        column = table["columns"][0]["id"]
        before = Table.objects.get(pk=table["id"]).version
        response, events = self.sent(lambda: self.client.patch(f"{self.base}/tables/{table['id']}/rows/{row['id']}/", {"values": {column: "hi"}}, format="json"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len([e for e in events if e[0] == "table"]), 0)  # no need for anyone to fetch
        name, data = events[0]
        self.assertEqual(name, "row")
        self.assertEqual((data["row"], data["values"], data["version"]), (row["id"], {column: "hi"}, before + 1))

    def test_new_rows_and_columns_tell_open_tables_to_look(self):
        table, _ = self.table_with_row()
        _, events = self.sent(lambda: self.client.post(f"{self.base}/tables/{table['id']}/rows/", {}, format="json"))
        self.assertIn("table", [name for name, _ in events])
        self.assertEqual([d["id"] for name, d in events if name == "table"][0], table["id"])

    def capability(self, user):
        self.client.force_authenticate(user)
        return json.loads(self.client.get("/api/live/token/").data["token_request"]["capability"])

    def test_only_editors_can_send_letters_as_they_type(self):
        self.assertIn("publish", self.capability(self.editor)[self.channel])
        viewer = self.capability(self.viewer)[self.channel]
        self.assertNotIn("publish", viewer)
        self.assertIn("subscribe", viewer)
        self.assertIn("presence", viewer)

    def test_people_outside_get_no_access(self):
        self.assertNotIn(self.channel, self.capability(self.outsider))

    def test_passes_are_short_lived(self):
        self.client.force_authenticate(self.editor)
        self.assertLessEqual(self.client.get("/api/live/token/").data["token_request"]["ttl"], 15 * 60 * 1000)
