import json
from datetime import timedelta
from unittest import mock

from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.models import User

from .models import ActivityEvent, Membership, Page, Table, Workspace

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


@override_settings(ABLY_API_KEY="", LIVE_SEND_ASYNC=False)
class AssigningYourselfTests(APITestCase):
    def setUp(self):
        self.owner, self.admin, self.editor = person("olivia"), person("adam"), person("eve")
        self.workspace = Workspace.objects.create(name="Dev Team")
        for user, role in ((self.owner, "owner"), (self.admin, "admin"), (self.editor, "editor")):
            Membership.objects.create(workspace=self.workspace, user=user, role=role)
        self.base = f"/api/workspaces/{self.workspace.pk}"
        self.client.force_authenticate(self.owner)
        self.table = self.client.post(f"{self.base}/tables/", {"title": "Bugs"}, format="json").data
        self.person_column = next(c["id"] for c in self.table["columns"] if c["type"] == "person")
        self.rows = f"{self.base}/tables/{self.table['id']}/rows/"
        self.row = self.client.post(self.rows, {}, format="json").data["id"]

    def assign(self, who, to):
        self.client.force_authenticate(who)
        return self.client.patch(f"{self.rows}{self.row}/", {"values": {self.person_column: to.pk}}, format="json")

    def test_the_owner_and_admins_cannot_assign_themselves(self):
        self.assertEqual(self.assign(self.owner, self.owner).status_code, 400)
        self.assertEqual(self.assign(self.admin, self.admin).status_code, 400)

    def test_nor_on_a_new_row(self):
        response = self.client.post(self.rows, {"values": {self.person_column: self.owner.pk}}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_they_can_assign_other_people(self):
        self.assertEqual(self.assign(self.owner, self.editor).status_code, 200)

    def test_an_editor_can_take_work_themselves(self):
        self.assertEqual(self.assign(self.editor, self.editor).status_code, 200)

    def test_a_row_already_theirs_can_still_be_edited(self):
        self.assertEqual(self.assign(self.editor, self.owner).status_code, 200)
        self.client.force_authenticate(self.owner)
        text = next(c["id"] for c in self.table["columns"] if c["type"] == "text")
        response = self.client.patch(f"{self.rows}{self.row}/", {"values": {text: "hi", self.person_column: self.owner.pk}}, format="json")
        self.assertEqual(response.status_code, 200)


class ActivityScreenTests(APITestCase):
    def setUp(self):
        self.owner, self.editor = person("olivia"), person("eve")
        self.workspace = Workspace.objects.create(name="Dev Team")
        for user, role in ((self.owner, "owner"), (self.editor, "editor")):
            Membership.objects.create(workspace=self.workspace, user=user, role=role)
        self.url = f"/api/workspaces/{self.workspace.pk}/activity/"
        self.client.force_authenticate(self.owner)
        now = timezone.now()
        for i in range(25):
            ActivityEvent.objects.create(workspace=self.workspace, actor=self.owner, verb="page.edited", target_kind="page", target_id=1, title=f"Notes {i}", created_at=now - timedelta(minutes=i))
        ActivityEvent.objects.create(workspace=self.workspace, actor=self.editor, verb="comment.row", target_kind="row", target_id=1, title="Bugs", detail={"no": 3, "table_id": 1}, created_at=now - timedelta(days=9))
        ActivityEvent.objects.create(workspace=self.workspace, actor=self.editor, verb="column.added", target_kind="table", target_id=1, title="Bugs", detail={"column": "Size"}, created_at=now - timedelta(days=9))

    def screen(self, **params):
        response = self.client.get(self.url, {"number": 1, **params})
        self.assertEqual(response.status_code, 200)
        return response.data

    def test_pages(self):
        first = self.screen()
        self.assertEqual((len(first["items"]), first["number"], first["pages"]), (20, 1, 2))
        self.assertIn("Notes 0", first["items"][0]["text"])
        last = self.screen(number=2)
        self.assertEqual(len(last["items"]), 7)
        self.assertEqual(self.screen(number=99)["number"], 2)

    def test_filters(self):
        self.assertEqual(len(self.screen(actor=self.editor.pk)["items"]), 2)
        self.assertIn("commented on row 3", self.screen(kind="comments")["items"][0]["text"])
        self.assertIn("added the column", self.screen(kind="tables")["items"][0]["text"])
        self.assertEqual(self.screen(kind="people")["items"], [])
        self.assertEqual(len(self.screen(q="Bugs")["items"]), 2)
        self.assertEqual(len(self.screen(q="eve")["items"]), 2)
        self.assertEqual(self.screen(since=timezone.now().isoformat())["items"], [])

    def test_the_reader_gets_their_own_language(self):
        User.objects.filter(pk=self.owner.pk).update(language="my")
        self.owner.refresh_from_db()
        self.client.force_authenticate(self.owner)
        self.assertIn("ပြင်လိုက်သည်", self.screen()["items"][0]["text"])

    def test_the_older_view_still_works(self):
        data = self.client.get(self.url).data
        self.assertIn("more", data)

    def test_outsiders_see_nothing(self):
        self.client.force_authenticate(person("otto"))
        self.assertEqual(self.client.get(self.url, {"number": 1}).status_code, 404)
