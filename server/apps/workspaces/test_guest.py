import tempfile
from datetime import timedelta

from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.models import User

from . import services
from .models import Comment, Invitation, Membership, Page, Table, TableRow, Workspace, WorkspaceFile

PASSWORD = "CorrectHorse-Battery9!"


def person(name):
    return User.objects.create_user(f"{name}@example.com", PASSWORD, full_name=name.title(), email_verified_at=timezone.now())


@override_settings(EMAIL_SEND_ASYNC=False, PUSH_SEND_ASYNC=False, FILE_STORAGE="local", FILE_DEV_DIR=tempfile.gettempdir())
class GuestLinkTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.owner, self.aung = person("olivia"), person("aung")
        self.workspace = Workspace.objects.create(name="Dev Team")
        Membership.objects.create(workspace=self.workspace, user=self.owner, role="owner")
        Membership.objects.create(workspace=self.workspace, user=self.aung, role="editor")
        self.page = Page.objects.create(workspace=self.workspace, title="Plan", blocks=[{"id": "a", "type": "p", "text": "Hello"}])
        self.table = Table.objects.create(
            workspace=self.workspace, title="Bugs",
            columns=[{"id": "who", "name": "Assigned", "type": "person"}, {"id": "pic", "name": "Shots", "type": "file"}],
        )
        self.row = TableRow.objects.create(table=self.table, no=1, values={"who": self.aung.pk})
        self.invitation = services.invite(self.owner, self.workspace.pk, "new.person@example.com", "editor")
        self.link = services.guest_token(self.invitation)
        self.client.force_authenticate(None)

    def get(self, path, token=None):
        return self.client.get(f"/api/workspaces/guest/{path}", HTTP_X_GUEST_TOKEN=token or self.link)

    def file(self, name="a.png"):
        return WorkspaceFile.objects.create(workspace=self.workspace, name=name, size=10, content_type="image/png", key=f"k/{name}", status="ready", is_image=True)

    def test_someone_without_an_account_gets_the_link_by_email(self):
        email = mail.outbox[-1]
        self.assertEqual(email.to, ["new.person@example.com"])
        self.assertIn(f"/guest/{self.link}", email.body)
        self.assertIn(f"/guest/{self.link}", email.alternatives[0][0])

    def test_someone_with_an_account_gets_no_guest_link(self):
        services.invite(self.owner, self.workspace.pk, person("mia").email, "viewer")
        email = mail.outbox[-1]
        self.assertNotIn("/guest/", email.body)
        self.assertNotIn("/guest/", email.alternatives[0][0])

    def invitations_for(self, user):
        self.client.force_authenticate(user)
        return self.client.get(f"/api/workspaces/{self.workspace.pk}/").data["invitations"]

    def test_the_owner_can_copy_a_working_link(self):
        link = self.invitations_for(self.owner)[0]["guest_url"]
        self.assertTrue(link.endswith(f"/guest/{self.link}"))
        self.client.force_authenticate(None)
        self.assertEqual(self.get("", token=link.rsplit("/", 1)[1]).status_code, 200)

    def test_only_people_who_manage_members_get_the_link(self):
        self.assertEqual(self.invitations_for(self.aung), [])
        Membership.objects.filter(workspace=self.workspace, user=self.aung).update(role="admin")
        self.assertIn("guest_url", self.invitations_for(self.aung)[0])

    def test_every_invitation_gets_a_link_so_it_cannot_show_who_has_an_account(self):
        services.invite(self.owner, self.workspace.pk, person("mia").email, "viewer")
        self.assertTrue(all(i["guest_url"] for i in self.invitations_for(self.owner)))

    def test_a_copied_link_lets_nobody_else_join(self):
        token = self.invitations_for(self.owner)[0]["guest_url"].rsplit("/", 1)[1]
        self.client.force_authenticate(None)
        self.assertEqual(self.get("", token=token).data["role"], "editor")
        self.client.force_authenticate(self.aung)
        self.assertEqual(self.client.post(f"/api/workspaces/invitations/{self.invitation.pk}/accept/").status_code, 404)

    def test_shows_the_workspace_without_giving_away_the_address(self):
        response = self.get("")
        self.assertEqual(response.status_code, 200)
        data = response.data
        self.assertEqual((data["name"], data["role"], data["invited_by"]), ("Dev Team", "editor", "Olivia"))
        self.assertEqual(data["email"], "n•••@example.com")
        self.assertEqual([p["title"] for p in data["pages"]], ["Plan"])
        self.assertEqual([t["title"] for t in data["tables"]], ["Bugs"])
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertNotIn("olivia@example.com", str(data))
        self.assertNotIn("members", data)

    def test_reads_pages_and_tables(self):
        self.assertEqual(self.get(f"pages/{self.page.pk}/").data["blocks"][0]["text"], "Hello")
        table = self.get(f"tables/{self.table.pk}/").data
        self.assertEqual(table["rows"][0]["values"]["who"], self.aung.pk)

    def test_tables_name_only_the_people_in_them(self):
        Membership.objects.create(workspace=self.workspace, user=person("sara"), role="viewer")
        members = self.get(f"tables/{self.table.pk}/").data["members"]
        self.assertEqual([(m["id"], m["full_name"], m["email"]) for m in members], [(self.aung.pk, "Aung", "")])

    def test_a_bad_link_opens_nothing(self):
        tampered = f"{self.invitation.pk + 1}.{self.link.split('.')[1]}"
        for token in ("", "nonsense", tampered, self.link + "x"):
            self.assertEqual(self.get("", token=token or " ").status_code, 404, token)
        self.assertEqual(self.client.get("/api/workspaces/guest/").status_code, 404)

    def test_stops_when_cancelled(self):
        self.client.force_authenticate(self.owner)
        self.client.delete(f"/api/workspaces/{self.workspace.pk}/invitations/{self.invitation.pk}/")
        self.client.force_authenticate(None)
        for path in ("", f"pages/{self.page.pk}/", f"tables/{self.table.pk}/", "files/?ids=1"):
            self.assertEqual(self.get(path).status_code, 404, path)

    def test_stops_when_expired_or_the_workspace_is_deleted(self):
        Invitation.objects.filter(pk=self.invitation.pk).update(expires_at=timezone.now() - timedelta(minutes=1))
        self.assertEqual(self.get("").status_code, 404)
        Invitation.objects.filter(pk=self.invitation.pk).update(expires_at=timezone.now() + timedelta(days=1))
        self.assertEqual(self.get("").status_code, 200)
        Workspace.objects.filter(pk=self.workspace.pk).update(deleted_at=timezone.now())
        self.assertEqual(self.get("").status_code, 404)

    def test_after_joining_it_sends_them_to_log_in(self):
        joined = User.objects.create_user("new.person@example.com", PASSWORD, full_name="New", email_verified_at=timezone.now())
        services.accept(joined, self.invitation.pk)
        response = self.get("")
        self.assertEqual(response.status_code, 404)
        self.assertIn("Log in", response.data["detail"])

    def test_cannot_reach_another_workspace(self):
        other = Workspace.objects.create(name="Other")
        page = Page.objects.create(workspace=other, title="Secret", blocks=[])
        table = Table.objects.create(workspace=other, title="Secret", columns=[])
        self.assertEqual(self.get(f"pages/{page.pk}/").status_code, 404)
        self.assertEqual(self.get(f"tables/{table.pk}/").status_code, 404)

    def test_binned_things_stay_hidden(self):
        Page.objects.filter(pk=self.page.pk).update(deleted_at=timezone.now())
        Table.objects.filter(pk=self.table.pk).update(deleted_at=timezone.now())
        self.assertEqual(self.get(f"pages/{self.page.pk}/").status_code, 404)
        self.assertEqual(self.get(f"tables/{self.table.pk}/").status_code, 404)
        data = self.get("").data
        self.assertEqual((data["pages"], data["tables"]), ([], []))

    def test_nothing_can_be_changed(self):
        urls = ["", f"pages/{self.page.pk}/", f"tables/{self.table.pk}/", "files/"]
        for path in urls:
            url = f"/api/workspaces/guest/{path}"
            for method in (self.client.post, self.client.patch, self.client.put, self.client.delete):
                self.assertEqual(method(url, {"title": "Hacked"}, format="json", HTTP_X_GUEST_TOKEN=self.link).status_code, 405, path)
        self.page.refresh_from_db()
        self.assertEqual(self.page.title, "Plan")

    def test_the_link_is_no_pass_to_the_normal_api(self):
        for path in ("", "pages/", f"pages/{self.page.pk}/", "activity/", "tables/", "files/?ids=1", f"pages/{self.page.pk}/comments/"):
            response = self.client.get(f"/api/workspaces/{self.workspace.pk}/{path}", HTTP_X_GUEST_TOKEN=self.link)
            self.assertEqual(response.status_code, 401, path)
        self.assertEqual(self.client.get("/api/auth/me/", HTTP_X_GUEST_TOKEN=self.link).status_code, 401)

    def test_files_only_from_pages_and_tables(self):
        on_page, in_cell, in_comment, unused, in_bin = (self.file(f"{name}.png") for name in ("page", "cell", "comment", "unused", "bin"))
        Page.objects.filter(pk=self.page.pk).update(blocks=[{"id": "f", "type": "file", "text": "", "file": on_page.pk}])
        TableRow.objects.filter(pk=self.row.pk).update(values={"pic": [in_cell.pk]})
        Comment.objects.create(workspace=self.workspace, page=self.page, author=self.owner, body="see", files=[in_comment.pk])
        binned = Page.objects.create(workspace=self.workspace, title="Old", blocks=[{"id": "f", "type": "file", "text": "", "file": in_bin.pk}])
        Page.objects.filter(pk=binned.pk).update(deleted_at=timezone.now())
        ids = ",".join(str(f.pk) for f in (on_page, in_cell, in_comment, unused, in_bin))
        response = self.get(f"files/?ids={ids}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual({f["id"] for f in response.data}, {on_page.pk, in_cell.pk})
        self.assertTrue(response.data[0]["url"])

    def test_a_bad_file_list_is_just_empty(self):
        self.assertEqual(self.get("files/?ids=abc").data, [])

    def test_comments_are_left_out(self):
        Comment.objects.create(workspace=self.workspace, page=self.page, author=self.owner, body="private note")
        self.assertNotIn("private note", str(self.get("").data))
        self.assertNotIn("private note", str(self.get(f"pages/{self.page.pk}/").data))
        self.assertEqual(self.get(f"tables/{self.table.pk}/").data["rows"][0]["comment_count"], 0)

    def test_joining_still_needs_the_invited_address(self):
        someone = person("someone")
        self.client.force_authenticate(someone)
        self.assertEqual(self.client.post(f"/api/workspaces/invitations/{self.invitation.pk}/accept/").status_code, 404)
        self.assertFalse(Membership.objects.filter(workspace=self.workspace, user=someone).exists())
        joined = User.objects.create_user("new.person@example.com", PASSWORD, full_name="New", email_verified_at=timezone.now())
        self.client.force_authenticate(joined)
        response = self.client.post(f"/api/workspaces/invitations/{self.invitation.pk}/accept/")
        self.assertEqual((response.status_code, response.data["role"]), (200, "editor"))
