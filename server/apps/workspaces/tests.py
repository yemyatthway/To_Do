from datetime import timedelta
from unittest import mock

from django.core import mail
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.tasks.models import Task
from apps.users.cleanup import prune
from apps.users.models import User
from apps.users.services import purge_account

from . import permissions as perms
from .models import ActivityEvent, Comment, Invitation, Membership, Notification, Page, Table, TableRow, Workspace

PASSWORD = "Sunny-Clock-2026"


def person(name):
    return User.objects.create_user(f"{name}@example.com", PASSWORD, full_name=name.capitalize(), email_verified_at=timezone.now())


@override_settings(EMAIL_SEND_ASYNC=False, PUSH_SEND_ASYNC=False)
class WorkspaceTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.owner, self.admin, self.editor, self.commenter, self.viewer, self.outsider = (person(n) for n in ["olivia", "adam", "eve", "carl", "vera", "otto"])
        self.client.force_authenticate(self.owner)
        self.ws = self.client.post("/api/workspaces/", {"name": "  Dev   Team "}, format="json").data["id"]
        for user, role in [(self.admin, "admin"), (self.editor, "editor"), (self.commenter, "commenter"), (self.viewer, "viewer")]:
            Membership.objects.create(workspace_id=self.ws, user=user, role=role)
        mail.outbox.clear()

    def as_(self, user):
        self.client.force_authenticate(user)
        return self.client

    def url(self, rest=""):
        return f"/api/workspaces/{self.ws}/{rest}"

    def role_of(self, user):
        return Membership.objects.get(workspace_id=self.ws, user=user).role

    def test_creating_makes_you_owner_and_cleans_the_name(self):
        data = self.as_(self.owner).get(self.url()).data
        self.assertEqual((data["name"], data["role"]), ("Dev Team", "owner"))
        self.assertEqual(self.client.post("/api/workspaces/", {"name": "   "}, format="json").status_code, 400)

    def test_outsiders_cannot_tell_a_workspace_exists(self):
        self.as_(self.outsider)
        for response in [
            self.client.get(self.url()),
            self.client.patch(self.url(), {"name": "x"}, format="json"),
            self.client.delete(self.url(), {"confirm_name": "Dev Team"}, format="json"),
            self.client.post(self.url("invitations/"), {"invitee": "@eve", "role": "viewer"}, format="json"),
            self.client.patch(self.url(f"members/{self.viewer.pk}/"), {"role": "editor"}, format="json"),
            self.client.delete(self.url(f"members/{self.viewer.pk}/")),
            self.client.post(self.url("transfer/"), {"user_id": self.outsider.pk}, format="json"),
        ]:
            self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client.get("/api/workspaces/").data["workspaces"], [])

    def test_every_role_gets_exactly_the_agreed_abilities(self):
        expected = {
            "owner": {"read", "comment", "edit", "manage_members", "rename", "delete_workspace", "transfer"},
            "admin": {"read", "comment", "edit", "manage_members", "rename"},
            "editor": {"read", "comment", "edit"},
            "commenter": {"read", "comment"},
            "viewer": {"read"},
        }
        for user, role in [(self.owner, "owner"), (self.admin, "admin"), (self.editor, "editor"), (self.commenter, "commenter"), (self.viewer, "viewer")]:
            can = self.as_(user).get(self.url()).data["can"]
            self.assertEqual({k for k, v in can.items() if v}, expected[role], role)

    def test_only_owner_and_admin_can_manage_and_the_server_says_no_to_others(self):
        for user in [self.editor, self.commenter, self.viewer]:
            self.as_(user)
            self.assertEqual(self.client.post(self.url("invitations/"), {"invitee": "@otto", "role": "viewer"}, format="json").status_code, 403)
            self.assertEqual(self.client.patch(self.url(f"members/{self.viewer.pk}/"), {"role": "editor"}, format="json").status_code, 403)
            self.assertEqual(self.client.delete(self.url(f"members/{self.owner.pk}/")).status_code, 403)
            self.assertEqual(self.client.patch(self.url(), {"name": "Taken"}, format="json").status_code, 403)
            self.assertEqual(self.client.get(self.url()).data["invitations"], [])  # can't even see them
        self.assertEqual(self.role_of(self.viewer), "viewer")
        self.assertEqual(Invitation.objects.count(), 0)

    def test_admins_cannot_touch_the_owner_or_other_admins_or_create_admins(self):
        second = person("bob")
        Membership.objects.create(workspace_id=self.ws, user=second, role="admin")
        self.as_(self.admin)
        self.assertEqual(self.client.patch(self.url(f"members/{self.owner.pk}/"), {"role": "viewer"}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(self.url(f"members/{second.pk}/"), {"role": "viewer"}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(self.url(f"members/{self.viewer.pk}/"), {"role": "admin"}, format="json").status_code, 403)
        self.assertEqual(self.client.delete(self.url(f"members/{second.pk}/")).status_code, 403)
        self.assertEqual(self.client.post(self.url("invitations/"), {"invitee": "@otto", "role": "admin"}, format="json").status_code, 403)
        self.assertEqual(self.client.patch(self.url(f"members/{self.viewer.pk}/"), {"role": "editor"}, format="json").status_code, 200)
        self.assertEqual(self.client.delete(self.url(f"members/{self.editor.pk}/")).status_code, 204)

    def test_no_one_can_become_owner_except_by_transfer(self):
        self.as_(self.owner)
        self.assertEqual(self.client.patch(self.url(f"members/{self.editor.pk}/"), {"role": "owner"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(self.url("invitations/"), {"invitee": "@otto", "role": "owner"}, format="json").status_code, 400)
        self.as_(self.admin)
        self.assertEqual(self.client.post(self.url("transfer/"), {"user_id": self.admin.pk}, format="json").status_code, 403)
        with self.assertRaises(IntegrityError), transaction.atomic():  # and the database refuses a second owner
            Membership.objects.filter(workspace_id=self.ws, user=self.editor).update(role="owner")

    def test_transfer_moves_ownership_and_steps_you_down(self):
        self.as_(self.owner)
        self.assertEqual(self.client.post(self.url("transfer/"), {"user_id": self.editor.pk}, format="json").status_code, 200)
        self.assertEqual((self.role_of(self.editor), self.role_of(self.owner)), ("owner", "admin"))
        self.assertEqual(self.client.delete(self.url(), {"confirm_name": "Dev Team"}, format="json").status_code, 403)

    def test_leaving_and_the_owner_cannot_leave(self):
        self.assertEqual(self.as_(self.viewer).delete(self.url(f"members/{self.viewer.pk}/")).status_code, 204)
        self.assertEqual(self.client.get(self.url()).status_code, 404)
        self.assertEqual(self.as_(self.owner).delete(self.url(f"members/{self.owner.pk}/")).status_code, 403)

    def test_delete_needs_the_exact_name_and_hides_it_from_everyone(self):
        self.as_(self.owner)
        self.assertEqual(self.client.delete(self.url(), {"confirm_name": "dev"}, format="json").status_code, 400)
        self.assertEqual(self.client.delete(self.url(), {"confirm_name": "Dev Team"}, format="json").status_code, 204)
        self.assertEqual(self.as_(self.viewer).get(self.url()).status_code, 404)
        self.assertEqual(Workspace.all_objects.filter(pk=self.ws).count(), 1)  # restorable for now
        Workspace.all_objects.filter(pk=self.ws).update(deleted_at=timezone.now() - timedelta(days=31))
        prune()
        self.assertEqual(Workspace.all_objects.filter(pk=self.ws).count(), 0)

    def invite(self, invitee, role="editor", by=None):
        return self.as_(by or self.owner).post(self.url("invitations/"), {"invitee": invitee, "role": role}, format="json")

    def test_invite_by_username_then_accept_with_the_invited_role(self):
        self.assertEqual(self.invite("@OTTO", "commenter").status_code, 201)
        self.assertEqual(mail.outbox[-1].to, ["otto@example.com"])
        self.assertIn("Olivia invited you to Dev Team", mail.outbox[-1].subject)
        self.assertEqual(self.as_(self.outsider).get(self.url()).status_code, 404)  # not a member until accepted
        inbox = self.client.get("/api/workspaces/").data["invitations"]
        self.assertEqual((inbox[0]["workspace"], inbox[0]["role"], inbox[0]["invited_by"]), ("Dev Team", "commenter", "Olivia"))
        self.assertEqual(self.client.post(f"/api/workspaces/invitations/{inbox[0]['id']}/accept/").data["role"], "commenter")
        self.assertEqual(self.client.get("/api/workspaces/").data["invitations"], [])

    def test_only_the_invited_person_can_answer(self):
        self.invite("@otto")
        invitation = Invitation.objects.get()
        self.assertEqual(self.as_(self.viewer).post(f"/api/workspaces/invitations/{invitation.pk}/accept/").status_code, 404)
        self.assertEqual(self.client.post(f"/api/workspaces/invitations/{invitation.pk}/decline/").status_code, 404)
        self.assertFalse(Membership.objects.filter(workspace_id=self.ws, user=self.outsider).exists())

    def test_an_unverified_address_cannot_claim_an_invitation(self):
        self.invite("new@example.com")
        squatter = User.objects.create_user("new@example.com", PASSWORD)
        self.assertEqual(self.as_(squatter).get("/api/workspaces/").status_code, 403)

    def test_email_invites_do_not_reveal_who_has_an_account_and_wait_for_sign_up(self):
        known, unknown = self.invite("otto@example.com"), self.invite("nobody@example.com")
        self.assertEqual((known.status_code, unknown.status_code), (201, 201))
        self.assertEqual(set(known.data) - {"invitations"}, set(unknown.data) - {"invitations"})
        labels = [i["label"] for i in unknown.data["invitations"]]
        self.assertIn("nobody@example.com", labels)
        later = User.objects.create_user("nobody@example.com", PASSWORD, email_verified_at=timezone.now())
        self.assertEqual(len(self.as_(later).get("/api/workspaces/").data["invitations"]), 1)

    def test_invite_problems_and_cancel_and_decline_and_expiry(self):
        self.assertIn("No one has", self.invite("@ghost").data["invitee"][0])
        self.assertIn("already in", self.invite("@eve").data["invitee"][0])
        self.assertIn("already in", self.invite(f"@{self.owner.username}").data["invitee"][0])
        self.assertEqual(self.invite("@otto").status_code, 201)
        self.assertIn("already have", self.invite("otto@example.com").data["invitee"][0])
        invitation = Invitation.objects.get()
        self.assertEqual(self.client.delete(self.url(f"invitations/{invitation.pk}/")).status_code, 204)
        self.assertEqual(self.as_(self.outsider).post(f"/api/workspaces/invitations/{invitation.pk}/accept/").status_code, 404)
        self.invite("@otto")
        second = Invitation.objects.get(status="pending")
        self.assertEqual(self.as_(self.outsider).post(f"/api/workspaces/invitations/{second.pk}/decline/").status_code, 204)
        self.invite("@otto")
        third = Invitation.objects.get(status="pending")
        Invitation.objects.filter(pk=third.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.as_(self.outsider).post(f"/api/workspaces/invitations/{third.pk}/accept/").status_code, 404)

    def test_member_lists_never_show_full_emails_or_tasks(self):
        members = self.as_(self.viewer).get(self.url()).data["members"]
        self.assertEqual(len(members), 5)
        for member in members:
            self.assertIn("•••", member["email"])
            self.assertEqual(set(member), {"id", "full_name", "username", "email", "role", "joined_at"})

    def test_erasing_an_owner_hands_over_or_removes_the_workspace(self):
        purge_account(self.owner)
        self.assertEqual(self.role_of(self.admin), "owner")
        solo = self.as_(self.outsider).post("/api/workspaces/", {"name": "Solo"}, format="json").data["id"]
        purge_account(self.outsider)
        self.assertFalse(Workspace.all_objects.filter(pk=solo).exists())

    @mock.patch("apps.live.ably.publish")
    def test_changes_reach_members_live(self, publish):
        self.as_(self.owner).patch(self.url(), {"name": "Renamed"}, format="json")
        batch = publish.call_args.args[0]
        self.assertEqual({channel for channel, _, _ in batch}, {f"user:{u.pk}" for u in [self.owner, self.admin, self.editor, self.commenter, self.viewer]})

    def test_rules_table_has_no_gaps(self):
        for action, roles in perms.ALLOWED.items():
            self.assertTrue(roles <= set(perms.ROLE_ORDER), action)
            self.assertIn(perms.OWNER, roles, action)


@override_settings(EMAIL_SEND_ASYNC=False, PUSH_SEND_ASYNC=False)
class PageTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.owner, self.editor, self.commenter, self.viewer, self.outsider = (person(n) for n in ["olivia", "eve", "carl", "vera", "otto"])
        self.client.force_authenticate(self.owner)
        self.ws = self.client.post("/api/workspaces/", {"name": "Dev Team"}, format="json").data["id"]
        for user, role in [(self.editor, "editor"), (self.commenter, "commenter"), (self.viewer, "viewer")]:
            Membership.objects.create(workspace_id=self.ws, user=user, role=role)

    def as_(self, user):
        self.client.force_authenticate(user)
        return self.client

    def url(self, rest=""):
        return f"/api/workspaces/{self.ws}/pages/{rest}"

    def make(self, title="Release plan"):
        return self.as_(self.editor).post(self.url(), {"title": title}, format="json").data

    def save(self, page, **body):
        return self.client.patch(self.url(f"{page['id']}/"), {"base_version": page["version"], **body}, format="json")

    def test_the_team_names_its_own_pages(self):
        page = self.make("  Sprint   12 notes ")
        self.assertEqual((page["title"], page["blocks"], page["version"]), ("Sprint 12 notes", [], 1))
        self.assertEqual([p["title"] for p in self.client.get(self.url()).data], ["Sprint 12 notes"])
        self.assertNotIn("blocks", self.client.get(self.url()).data[0])
        self.assertEqual(self.make("   ")["title"], "Untitled")
        self.assertEqual(len(self.make("x" * 300)["title"]), 120)

    def test_only_editors_and_above_can_change_pages(self):
        page = self.make()
        for user in (self.commenter, self.viewer):
            self.assertEqual(self.as_(user).get(self.url(f"{page['id']}/")).status_code, 200)
            self.assertEqual(self.client.get(self.url()).status_code, 200)
            self.assertEqual(self.client.post(self.url(), {"title": "No"}, format="json").status_code, 403)
            self.assertEqual(self.save(page, title="No").status_code, 403)
            self.assertEqual(self.client.delete(self.url(f"{page['id']}/")).status_code, 403)
            self.assertEqual(self.client.post(self.url(f"{page['id']}/restore/")).status_code, 403)
        self.assertEqual(Page.objects.get(pk=page["id"]).title, "Release plan")

    def test_people_outside_cannot_tell_it_exists(self):
        page = self.make()
        self.as_(self.outsider)
        self.assertEqual(self.client.get(self.url()).status_code, 404)
        self.assertEqual(self.client.get(self.url(f"{page['id']}/")).status_code, 404)
        self.assertEqual(self.save(page, title="No").status_code, 404)
        self.assertEqual(self.client.delete(self.url(f"{page['id']}/")).status_code, 404)

    def test_a_page_id_from_another_workspace_is_not_found(self):
        page = self.make()
        other = self.as_(self.outsider).post("/api/workspaces/", {"name": "Mine"}, format="json").data["id"]
        for call in (
            self.client.get(f"/api/workspaces/{other}/pages/{page['id']}/"),
            self.client.patch(f"/api/workspaces/{other}/pages/{page['id']}/", {"base_version": 1, "title": "Stolen"}, format="json"),
            self.client.delete(f"/api/workspaces/{other}/pages/{page['id']}/"),
        ):
            self.assertEqual(call.status_code, 404)
        self.assertEqual(Page.objects.get(pk=page["id"]).title, "Release plan")

    def test_saving_keeps_the_blocks_and_counts_up(self):
        page = self.make()
        blocks = [{"id": "a", "type": "h", "text": "Goal"}, {"id": "b", "type": "todo", "text": "Ship it", "done": True}, {"id": "c", "type": "p", "text": "<b>plain</b>", "done": True, "extra": 1}]
        saved = self.save(page, blocks=blocks, title="Plan").data
        self.assertEqual(saved["version"], 2)
        self.assertEqual(saved["title"], "Plan")
        self.assertEqual(saved["updated_by"], "Eve")
        # Only known fields are stored; a checkmark only exists on checklist items.
        self.assertEqual(saved["blocks"][2], {"id": "c", "type": "p", "text": "<b>plain</b>"})
        self.assertEqual(saved["blocks"][1]["done"], True)

    def test_an_edit_from_an_old_copy_cannot_overwrite_a_newer_one(self):
        page = self.make()
        self.assertEqual(self.save(page, title="First").status_code, 200)
        late = self.save(page, title="Second")
        self.assertEqual(late.status_code, 409)
        self.assertEqual((late.data["current"]["title"], late.data["current"]["version"]), ("First", 2))
        self.assertEqual(Page.objects.get(pk=page["id"]).title, "First")
        # The person chose to keep theirs: now it's based on the newest version.
        self.assertEqual(self.save({**page, "version": 2}, title="Second").status_code, 200)

    def test_a_save_must_say_what_it_started_from(self):
        page = self.make()
        for bad in (None, "1", True, 1.0):
            self.assertEqual(self.client.patch(self.url(f"{page['id']}/"), {"base_version": bad, "title": "x"}, format="json").status_code, 400)

    def test_bad_content_is_refused(self):
        page = self.make()
        for blocks in (
            "text",
            [1],
            [{"id": "a", "type": "script", "text": "x"}],
            [{"id": "a", "type": "p"}],
            [{"id": "a", "type": "p", "text": 5}],
            [{"type": "p", "text": "x"}],
            [{"id": "a", "type": "p", "text": "x"}, {"id": "a", "type": "p", "text": "y"}],
            [{"id": "x" * 65, "type": "p", "text": "x"}],
            [{"id": "a", "type": "p", "text": "x" * 10_001}],
            [{"id": str(i), "type": "p", "text": "x" * 9_000} for i in range(30)],
            [{"id": str(i), "type": "p", "text": ""} for i in range(2001)],
        ):
            self.assertEqual(self.save(page, blocks=blocks).status_code, 400, str(blocks)[:60])
        self.assertEqual(Page.objects.get(pk=page["id"]).version, 1)

    def test_deleting_hides_it_and_restoring_brings_it_back(self):
        page = self.make()
        self.assertEqual(self.client.delete(self.url(f"{page['id']}/")).status_code, 204)
        self.assertEqual(self.client.get(self.url()).data, [])
        self.assertEqual(self.client.get(self.url(f"{page['id']}/")).status_code, 404)
        self.assertEqual(self.save(page, title="Ghost").status_code, 404)
        self.assertEqual(self.client.post(self.url(f"{page['id']}/restore/")).data["title"], "Release plan")
        self.assertEqual(len(self.client.get(self.url()).data), 1)
        self.assertEqual(self.client.post(self.url(f"{page['id']}/restore/")).status_code, 404)

    def test_a_deleted_workspace_takes_its_pages_with_it(self):
        page = self.make()
        self.as_(self.owner).delete(f"/api/workspaces/{self.ws}/", {"confirm_name": "Dev Team"}, format="json")
        self.assertEqual(self.client.get(self.url(f"{page['id']}/")).status_code, 404)

    def test_the_clean_up_erases_old_deleted_pages_only(self):
        keep, recent, old = self.make("Keep"), self.make("Recent"), self.make("Old")
        Page.all_objects.filter(pk=recent["id"]).update(deleted_at=timezone.now() - timedelta(days=1))
        Page.all_objects.filter(pk=old["id"]).update(deleted_at=timezone.now() - timedelta(days=400))
        prune()
        self.assertEqual(set(Page.all_objects.filter(workspace_id=self.ws).values_list("title", flat=True)), {"Keep", "Recent"})
        self.assertTrue(Page.objects.filter(pk=keep["id"]).exists())

    def test_an_erased_account_leaves_the_pages_it_wrote(self):
        page = self.make()
        purge_account(self.editor)
        fresh = Page.objects.get(pk=page["id"])
        self.assertIsNone(fresh.created_by)
        self.assertIsNone(self.as_(self.owner).get(self.url(f"{page['id']}/")).data["updated_by"])


@override_settings(EMAIL_SEND_ASYNC=False, PUSH_SEND_ASYNC=False)
class TableTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.owner, self.editor, self.commenter, self.viewer, self.outsider = (person(n) for n in ["olivia", "eve", "carl", "vera", "otto"])
        self.client.force_authenticate(self.owner)
        self.ws = self.client.post("/api/workspaces/", {"name": "Dev Team"}, format="json").data["id"]
        for user, role in [(self.editor, "editor"), (self.commenter, "commenter"), (self.viewer, "viewer")]:
            Membership.objects.create(workspace_id=self.ws, user=user, role=role)
        self.table = self.as_(self.editor).post(self.url(), {"title": " M1  A/B Testing "}, format="json").data
        self.tid = self.table["id"]
        self.desc, self.who, self.done = (c["id"] for c in self.table["columns"])

    def as_(self, user):
        self.client.force_authenticate(user)
        return self.client

    def url(self, rest=""):
        return f"/api/workspaces/{self.ws}/tables/{rest}"

    def t(self, rest=""):
        return self.url(f"{self.tid}/{rest}")

    def add_row(self, **values):
        return self.client.post(self.t("rows/"), {"values": values}, format="json")

    def column(self, name, kind):
        return self.client.post(self.t("columns/"), {"name": name, "type": kind}, format="json").data["columns"][-1]["id"]

    def test_a_new_table_is_named_by_the_team_and_ready_to_use(self):
        self.assertEqual(self.table["title"], "M1 A/B Testing")
        self.assertEqual([(c["name"], c["type"]) for c in self.table["columns"]], [("Description", "text"), ("Assigned", "person"), ("Done", "checkbox")])
        self.assertEqual(self.table["rows"], [])
        self.assertEqual([t["title"] for t in self.client.get(self.url()).data], ["M1 A/B Testing"])
        self.assertNotIn("rows", self.client.get(self.url()).data[0])

    def test_rows_number_themselves_and_never_reuse_a_number(self):
        first = self.add_row().data
        second = self.add_row().data
        self.assertEqual((first["no"], second["no"]), (1, 2))
        self.client.delete(self.t(f"rows/{second['id']}/"))
        self.assertEqual(self.add_row().data["no"], 3)
        self.assertEqual([r["no"] for r in self.client.get(self.t()).data["rows"]], [1, 3])

    def test_only_editors_and_above_can_change_anything(self):
        row = self.add_row().data
        for user in (self.commenter, self.viewer):
            self.as_(user)
            self.assertEqual(self.client.get(self.t()).status_code, 200)
            self.assertEqual(self.client.post(self.url(), {"title": "No"}, format="json").status_code, 403)
            self.assertEqual(self.client.patch(self.t(), {"title": "No"}, format="json").status_code, 403)
            self.assertEqual(self.client.delete(self.t()).status_code, 403)
            self.assertEqual(self.client.post(self.t("restore/")).status_code, 403)
            self.assertEqual(self.client.post(self.t("columns/"), {"name": "No", "type": "text"}, format="json").status_code, 403)
            self.assertEqual(self.client.patch(self.t(f"columns/{self.desc}/"), {"name": "No"}, format="json").status_code, 403)
            self.assertEqual(self.client.delete(self.t(f"columns/{self.desc}/")).status_code, 403)
            self.assertEqual(self.add_row().status_code, 403)
            self.assertEqual(self.client.patch(self.t(f"rows/{row['id']}/"), {"values": {self.desc: "No"}}, format="json").status_code, 403)
            self.assertEqual(self.client.delete(self.t(f"rows/{row['id']}/")).status_code, 403)
            self.assertEqual(self.client.post(self.t(f"rows/{row['id']}/restore/")).status_code, 403)
        fresh = TableRow.objects.get(pk=row["id"])
        self.assertEqual(fresh.values, {})

    def test_people_outside_cannot_tell_it_exists(self):
        row = self.add_row().data
        self.as_(self.outsider)
        self.assertEqual(self.client.get(self.url()).status_code, 404)
        self.assertEqual(self.client.get(self.t()).status_code, 404)
        self.assertEqual(self.add_row().status_code, 404)
        self.assertEqual(self.client.post(self.t(f"rows/{row['id']}/add-to-tasks/")).status_code, 404)

    def test_ids_from_another_workspace_or_table_are_not_found(self):
        row = self.add_row().data
        other_table = self.client.post(self.url(), {"title": "Other"}, format="json").data["id"]
        self.assertEqual(self.client.patch(self.url(f"{other_table}/rows/{row['id']}/"), {"values": {}}, format="json").status_code, 404)
        self.assertEqual(self.client.delete(self.url(f"{other_table}/rows/{row['id']}/")).status_code, 404)
        mine = self.as_(self.outsider).post("/api/workspaces/", {"name": "Mine"}, format="json").data["id"]
        self.assertEqual(self.client.get(f"/api/workspaces/{mine}/tables/{self.tid}/").status_code, 404)
        self.assertEqual(self.client.patch(f"/api/workspaces/{mine}/tables/{self.tid}/rows/{row['id']}/", {"values": {}}, format="json").status_code, 404)

    def test_each_column_type_keeps_good_values_and_refuses_bad_ones(self):
        columns = {kind: self.column(kind, kind) for kind in ["text", "number", "select", "person", "date", "checkbox"]}
        row = self.add_row().data["id"]
        good = [
            ("text", "Hello <b>", "Hello <b>"), ("text", None, ""),
            ("number", 3.5, 3.5), ("number", None, None),
            ("select", "  In   progress ", "In progress"), ("select", "", None),
            ("person", self.viewer.pk, self.viewer.pk), ("person", None, None),
            ("date", "2030-01-02T03:04:00+06:30", "2030-01-01T20:34:00+00:00"), ("date", "", None),
            ("checkbox", True, True), ("checkbox", None, False),
        ]
        for kind, sent, kept in good:
            response = self.client.patch(self.t(f"rows/{row}/"), {"values": {columns[kind]: sent}}, format="json")
            self.assertEqual(response.status_code, 200, (kind, sent))
            self.assertEqual(response.data["values"][columns[kind]], kept, (kind, sent))
        bad = [
            ("text", 5), ("text", "x" * 5001),
            ("number", "5"), ("number", True), ("number", 1e16),
            ("select", 5), ("select", "x" * 61),
            ("person", self.outsider.pk), ("person", "1"), ("person", True),
            ("date", "tomorrow"), ("date", "2030-01-02T03:04:00"), ("date", 5), ("date", "2030-13-45T03:04:00+00:00"),
            ("checkbox", "yes"), ("checkbox", 1),
        ]
        for kind, sent in bad:
            self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), {"values": {columns[kind]: sent}}, format="json").status_code, 400, (kind, sent))
        self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), {"values": {"nope": 1}}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), {"values": "text"}, format="json").status_code, 400)
        self.assertEqual(self.add_row(nope=1).status_code, 400)

    def test_an_edit_from_an_old_copy_cannot_overwrite_a_newer_cell(self):
        row = self.add_row(**{self.desc: "First"}).data["id"]
        self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), {"values": {self.desc: "Second"}, "base": {self.desc: "First"}}, format="json").status_code, 200)
        late = self.client.patch(self.t(f"rows/{row}/"), {"values": {self.desc: "Third"}, "base": {self.desc: "First"}}, format="json")
        self.assertEqual(late.status_code, 409)
        self.assertEqual(late.data["current"]["values"][self.desc], "Second")
        self.assertEqual(TableRow.objects.get(pk=row).values[self.desc], "Second")

    def test_two_people_changing_different_cells_both_win(self):
        row = self.add_row(**{self.desc: "Bug"}).data["id"]
        self.client.patch(self.t(f"rows/{row}/"), {"values": {self.done: True}, "base": {self.done: None}}, format="json")
        response = self.as_(self.owner).patch(self.t(f"rows/{row}/"), {"values": {self.desc: "Bug 2"}, "base": {self.desc: "Bug"}}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.data["values"][self.done], response.data["values"][self.desc]), (True, "Bug 2"))

    def test_sending_the_same_edit_twice_is_not_a_conflict(self):
        row = self.add_row(**{self.desc: "First"}).data["id"]
        edit = {"values": {self.desc: "Second"}, "base": {self.desc: "First"}}
        self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), edit, format="json").status_code, 200)
        self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), edit, format="json").status_code, 200)

    def test_highlighting_a_row(self):
        row = self.add_row().data["id"]
        self.assertIs(self.client.patch(self.t(f"rows/{row}/"), {"highlighted": True}, format="json").data["highlighted"], True)
        self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), {"highlighted": "yes"}, format="json").status_code, 400)

    def test_columns_can_be_added_renamed_moved_and_removed(self):
        page = self.column("Page", "select")
        row = self.add_row(**{page: "Login"}).data["id"]
        renamed = self.client.patch(self.t(f"columns/{page}/"), {"name": " Screen "}, format="json").data
        self.assertEqual(renamed["columns"][-1]["name"], "Screen")
        moved = self.client.patch(self.t(f"columns/{page}/"), {"position": 0}, format="json").data
        self.assertEqual([c["id"] for c in moved["columns"]], [page, self.desc, self.who, self.done])
        self.assertEqual(self.client.patch(self.t(f"columns/{page}/"), {"position": "0"}, format="json").status_code, 400)
        gone = self.client.delete(self.t(f"columns/{page}/")).data
        self.assertNotIn(page, [c["id"] for c in gone["columns"]])
        self.assertNotIn(page, next(r for r in gone["rows"] if r["id"] == row)["values"])
        self.assertEqual(self.client.delete(self.t(f"columns/{page}/")).status_code, 404)
        self.assertEqual(self.client.post(self.t("columns/"), {"name": "X", "type": "script"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(self.t("columns/"), {"name": "  ", "type": "text"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(self.t("columns/"), {"name": "x" * 61, "type": "text"}, format="json").status_code, 400)

    def test_open_screens_can_ask_if_anything_changed(self):
        version = self.client.get(self.t()).data["version"]
        self.assertEqual(self.client.get(self.t(), {"known": version}).data, {"unchanged": True})
        row = self.add_row().data["id"]
        self.assertIn("rows", self.client.get(self.t(), {"known": version}).data)
        for change in (
            lambda: self.client.patch(self.t(f"rows/{row}/"), {"values": {self.desc: "x"}}, format="json"),
            lambda: self.client.delete(self.t(f"rows/{row}/")),
            lambda: self.client.post(self.t(f"rows/{row}/restore/")),
            lambda: self.client.post(self.t("columns/"), {"name": "Y", "type": "text"}, format="json"),
            lambda: self.client.patch(self.t(), {"description": "New"}, format="json"),
        ):
            version = self.client.get(self.t()).data["version"]
            change()
            self.assertIn("rows", self.client.get(self.t(), {"known": version}).data)

    def test_deleting_and_restoring_rows_and_tables(self):
        row = self.add_row(**{self.desc: "Bug"}).data["id"]
        self.assertEqual(self.client.delete(self.t(f"rows/{row}/")).status_code, 204)
        self.assertEqual(self.client.get(self.t()).data["rows"], [])
        self.assertEqual(self.client.patch(self.t(f"rows/{row}/"), {"values": {}}, format="json").status_code, 404)
        self.assertEqual(self.client.post(self.t(f"rows/{row}/restore/")).data["values"][self.desc], "Bug")
        self.assertEqual(self.client.post(self.t(f"rows/{row}/restore/")).status_code, 404)
        self.assertEqual(self.client.delete(self.t()).status_code, 204)
        self.assertEqual(self.client.get(self.t()).status_code, 404)
        self.assertEqual(self.client.get(self.url()).data, [])
        self.assertEqual(len(self.client.post(self.t("restore/")).data["rows"]), 1)

    def test_the_clean_up_erases_old_deleted_tables_and_rows_only(self):
        keep, old = self.add_row().data["id"], self.add_row().data["id"]
        TableRow.all_objects.filter(pk=old).update(deleted_at=timezone.now() - timedelta(days=400))
        gone_table = self.client.post(self.url(), {"title": "Old"}, format="json").data["id"]
        Table.all_objects.filter(pk=gone_table).update(deleted_at=timezone.now() - timedelta(days=400))
        prune()
        self.assertTrue(TableRow.objects.filter(pk=keep).exists())
        self.assertFalse(TableRow.all_objects.filter(pk=old).exists())
        self.assertFalse(Table.all_objects.filter(pk=gone_table).exists())
        self.assertTrue(Table.objects.filter(pk=self.tid).exists())

    def test_a_row_goes_on_your_own_task_list_once(self):
        when = self.column("Due", "date")
        due = (timezone.now() + timedelta(days=1)).isoformat()
        row = self.add_row(**{self.desc: "  Fix   the\nlogin ", when: due}).data["id"]
        # Even a viewer can put team work on their own list.
        first = self.as_(self.viewer).post(self.t(f"rows/{row}/add-to-tasks/"))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.data["task_title"], "Fix the login")
        self.assertTrue(first.data["row"]["on_my_tasks"])
        task = Task.objects.get(owner=self.viewer)
        self.assertEqual((task.source_row_id, task.category, task.remind_before_minutes), (row, "work", 10))
        self.assertEqual(task.notes, "From M1 A/B Testing in Dev Team, row 1")
        self.assertIsNotNone(task.due_at)
        self.assertEqual(self.client.post(self.t(f"rows/{row}/add-to-tasks/")).status_code, 200)
        self.assertEqual(Task.objects.filter(owner=self.viewer).count(), 1)
        self.assertTrue(self.client.get(self.t()).data["rows"][0]["on_my_tasks"])
        # It's personal: nobody else's row or list changes.
        self.assertFalse(self.as_(self.editor).get(self.t()).data["rows"][0]["on_my_tasks"])
        self.assertFalse(Task.objects.filter(owner=self.editor).exists())

    def test_a_row_without_text_or_future_date_still_makes_a_sensible_task(self):
        when = self.column("Due", "date")
        row = self.add_row(**{when: (timezone.now() - timedelta(days=1)).isoformat()}).data["id"]
        self.client.post(self.t(f"rows/{row}/add-to-tasks/"))
        task = Task.objects.get(owner=self.editor)
        self.assertEqual((task.title, task.due_at, task.remind_before_minutes), ("M1 A/B Testing 1", None, None))

    def test_deleting_the_task_lets_you_add_the_row_again(self):
        row = self.add_row().data["id"]
        self.client.post(self.t(f"rows/{row}/add-to-tasks/"))
        Task.objects.filter(owner=self.editor).update(deleted_at=timezone.now())
        self.assertFalse(self.client.get(self.t()).data["rows"][0]["on_my_tasks"])
        self.client.post(self.t(f"rows/{row}/add-to-tasks/"))
        self.assertEqual(Task.objects.filter(owner=self.editor).count(), 1)

    def test_the_task_survives_when_the_row_is_erased(self):
        row = self.add_row().data["id"]
        self.client.post(self.t(f"rows/{row}/add-to-tasks/"))
        TableRow.all_objects.filter(pk=row).delete()
        self.assertIsNone(Task.objects.get(owner=self.editor).source_row)

    def test_a_row_limit_protects_the_table(self):
        with mock.patch("apps.workspaces.services.MAX_ROWS", 1):
            self.assertEqual(self.add_row().status_code, 201)
            self.assertEqual(self.add_row().status_code, 400)


@override_settings(EMAIL_SEND_ASYNC=False, PUSH_SEND_ASYNC=False)
class TeamworkTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.owner, self.admin, self.editor, self.commenter, self.viewer, self.outsider = (person(n) for n in ["olivia", "adam", "eve", "carl", "vera", "otto"])
        self.client.force_authenticate(self.owner)
        self.ws = self.client.post("/api/workspaces/", {"name": "Dev Team"}, format="json").data["id"]
        for user, role in [(self.admin, "admin"), (self.editor, "editor"), (self.commenter, "commenter"), (self.viewer, "viewer")]:
            Membership.objects.create(workspace_id=self.ws, user=user, role=role)
        self.page = self.as_(self.editor).post(self.w("pages/"), {"title": "Release plan"}, format="json").data["id"]
        table = self.client.post(self.w("tables/"), {"title": "Bugs"}, format="json").data
        self.tid = table["id"]
        self.desc, self.who, self.done = (c["id"] for c in table["columns"])
        self.row = self.client.post(self.w(f"tables/{self.tid}/rows/"), {"values": {self.desc: "Fix login"}}, format="json").data["id"]
        Notification.objects.all().delete()

    def as_(self, user):
        self.client.force_authenticate(user)
        return self.client

    def w(self, rest=""):
        return f"/api/workspaces/{self.ws}/{rest}"

    def page_comment(self, body):
        return self.client.post(self.w(f"pages/{self.page}/comments/"), {"body": body}, format="json")

    def row_comment(self, body):
        return self.client.post(self.w(f"tables/{self.tid}/rows/{self.row}/comments/"), {"body": body}, format="json")

    def inbox(self, user):
        return self.as_(user).get("/api/workspaces/notifications/").data

    def test_commenters_and_up_can_comment_and_viewers_can_read(self):
        for user in (self.owner, self.admin, self.editor, self.commenter):
            self.as_(user)
            self.assertEqual(self.page_comment("Looks good").status_code, 201)
            self.assertEqual(self.row_comment("Looks good").status_code, 201)
        self.as_(self.viewer)
        self.assertEqual(self.page_comment("No").status_code, 403)
        self.assertEqual(self.row_comment("No").status_code, 403)
        self.assertEqual(len(self.client.get(self.w(f"pages/{self.page}/comments/")).data), 4)
        self.assertEqual(len(self.client.get(self.w(f"tables/{self.tid}/rows/{self.row}/comments/")).data), 4)

    def test_people_outside_get_nothing(self):
        self.as_(self.editor)
        comment = self.page_comment("Secret").data["id"]
        self.as_(self.outsider)
        for call in (
            self.client.get(self.w(f"pages/{self.page}/comments/")),
            self.page_comment("Hi"),
            self.client.get(self.w(f"tables/{self.tid}/rows/{self.row}/comments/")),
            self.row_comment("Hi"),
            self.client.delete(self.w(f"comments/{comment}/")),
            self.client.get(self.w("activity/")),
        ):
            self.assertEqual(call.status_code, 404)

    def test_ids_from_elsewhere_are_not_found(self):
        other = self.as_(self.outsider).post("/api/workspaces/", {"name": "Mine"}, format="json").data["id"]
        self.assertEqual(self.client.post(f"/api/workspaces/{other}/pages/{self.page}/comments/", {"body": "x"}, format="json").status_code, 404)
        self.assertEqual(self.client.post(f"/api/workspaces/{other}/tables/{self.tid}/rows/{self.row}/comments/", {"body": "x"}, format="json").status_code, 404)
        second = self.as_(self.editor).post(self.w("tables/"), {"title": "Other"}, format="json").data["id"]
        self.assertEqual(self.client.get(self.w(f"tables/{second}/rows/{self.row}/comments/")).status_code, 404)

    def test_empty_or_long_comments_are_refused(self):
        self.as_(self.editor)
        self.assertEqual(self.page_comment("   ").status_code, 400)
        self.assertEqual(self.page_comment("x" * 2001).status_code, 400)
        self.assertEqual(self.page_comment("  trimmed ").data["body"], "trimmed")

    def test_you_can_delete_your_own_and_admins_can_delete_any(self):
        self.as_(self.commenter)
        mine = self.page_comment("Mine").data
        self.assertTrue(mine["can_delete"])
        self.as_(self.editor)
        self.assertFalse(next(c for c in self.client.get(self.w(f"pages/{self.page}/comments/")).data if c["id"] == mine["id"])["can_delete"])
        self.assertEqual(self.client.delete(self.w(f"comments/{mine['id']}/")).status_code, 403)
        self.as_(self.admin)
        self.assertEqual(self.client.delete(self.w(f"comments/{mine['id']}/")).status_code, 204)
        self.assertEqual(self.client.get(self.w(f"pages/{self.page}/comments/")).data, [])
        self.assertEqual(self.client.delete(self.w(f"comments/{mine['id']}/")).status_code, 404)

    def test_a_mention_notifies_members_only_and_never_yourself(self):
        names = {u: u.username for u in (self.owner, self.editor, self.viewer, self.outsider)}
        self.as_(self.owner)
        self.page_comment(f"@{names[self.editor]} and @{names[self.viewer].upper()} check this, cc @{names[self.outsider]} @{names[self.owner]} me@example.com")
        self.assertEqual(self.inbox(self.editor)["unread"], 1)
        item = self.inbox(self.viewer)["items"][0]
        self.assertEqual(item["kind"], "mention")
        self.assertEqual(item["title"], "Olivia mentioned you on Release plan")
        self.assertEqual(item["url"], f"/workspaces/{self.ws}/pages/{self.page}")
        self.assertEqual(self.inbox(self.outsider)["unread"], 0)
        self.assertEqual(self.inbox(self.owner)["unread"], 0)

    def test_commenting_tells_whoever_is_assigned_and_earlier_commenters_once(self):
        self.as_(self.editor).patch(self.w(f"tables/{self.tid}/rows/{self.row}/"), {"values": {self.who: self.commenter.pk}}, format="json")
        self.assertEqual(self.inbox(self.commenter)["items"][0]["kind"], "assigned")
        Notification.objects.all().delete()
        self.as_(self.admin)
        self.row_comment("First")
        self.assertEqual(self.inbox(self.commenter)["items"][0]["kind"], "comment")
        self.assertEqual(self.inbox(self.admin)["unread"], 0)
        Notification.objects.all().delete()
        # Mentioning someone who'd also hear as a follower gives them just the mention.
        self.as_(self.owner)
        self.row_comment(f"@{self.commenter.username} what do you think?")
        kinds = [n["kind"] for n in self.inbox(self.commenter)["items"]]
        self.assertEqual(kinds, ["mention"])
        self.assertEqual([n["kind"] for n in self.inbox(self.admin)["items"]], ["comment"])

    def test_being_assigned_a_row_tells_you_unless_you_did_it(self):
        url = self.w(f"tables/{self.tid}/rows/{self.row}/")
        self.as_(self.editor).patch(url, {"values": {self.who: self.editor.pk}}, format="json")
        self.assertEqual(self.inbox(self.editor)["unread"], 0)
        self.as_(self.editor).patch(url, {"values": {self.who: self.viewer.pk}}, format="json")
        item = self.inbox(self.viewer)["items"][0]
        self.assertEqual(item["title"], "Eve assigned you row 1 of Bugs")
        self.assertEqual(item["body"], "Fix login")
        self.assertEqual(item["url"], f"/workspaces/{self.ws}/tables/{self.tid}/rows/{self.row}")
        # Saving the same value again isn't a new assignment.
        self.as_(self.editor).patch(url, {"values": {self.who: self.viewer.pk}}, format="json")
        self.assertEqual(self.inbox(self.viewer)["unread"], 1)

    def test_a_new_row_assigned_to_someone_tells_them(self):
        self.as_(self.editor).post(self.w(f"tables/{self.tid}/rows/"), {"values": {self.who: self.viewer.pk}}, format="json")
        self.assertEqual(self.inbox(self.viewer)["unread"], 1)

    def test_marking_read(self):
        self.as_(self.owner)
        self.page_comment(f"@{self.viewer.username} one")
        self.page_comment(f"@{self.viewer.username} two")
        items = self.inbox(self.viewer)["items"]
        self.assertEqual(self.client.post("/api/workspaces/notifications/read/", {"ids": [items[0]["id"]]}, format="json").status_code, 204)
        self.assertEqual(self.inbox(self.viewer)["unread"], 1)
        self.assertEqual(self.client.post("/api/workspaces/notifications/read/", {"ids": "all"}, format="json").status_code, 400)
        self.client.post("/api/workspaces/notifications/read/", {}, format="json")
        self.assertEqual(self.inbox(self.viewer)["unread"], 0)

    def test_you_can_only_mark_your_own(self):
        self.as_(self.owner)
        self.page_comment(f"@{self.viewer.username} one")
        other = Notification.objects.get(recipient=self.viewer).pk
        self.as_(self.editor).post("/api/workspaces/notifications/read/", {"ids": [other]}, format="json")
        self.assertEqual(self.inbox(self.viewer)["unread"], 1)
        self.as_(self.editor).post("/api/workspaces/notifications/read/", {}, format="json")
        self.assertEqual(self.inbox(self.viewer)["unread"], 1)

    def test_notifications_from_a_deleted_workspace_disappear(self):
        self.as_(self.owner)
        self.page_comment(f"@{self.viewer.username} one")
        self.client.delete(f"/api/workspaces/{self.ws}/", {"confirm_name": "Dev Team"}, format="json")
        self.assertEqual(self.inbox(self.viewer), {"items": [], "unread": 0, "more": False})

    def test_notifications_come_in_pages(self):
        self.as_(self.owner)
        for i in range(31):
            Notification.objects.create(recipient=self.viewer, actor=self.owner, workspace_id=self.ws, kind="comment", title=str(i), url="/")
        first = self.inbox(self.viewer)
        self.assertEqual((len(first["items"]), first["more"], first["unread"]), (30, True, 31))
        self.assertEqual(len(self.client.get("/api/workspaces/notifications/", {"before": first["items"][-1]["id"]}).data["items"]), 1)

    def test_history_reads_in_words_and_links_to_the_thing(self):
        self.as_(self.editor).patch(self.w(f"tables/{self.tid}/rows/{self.row}/"), {"values": {self.desc: "New"}}, format="json")
        self.client.post(self.w(f"tables/{self.tid}/columns/"), {"name": "Page", "type": "select"}, format="json")
        self.page_comment("Hi")
        self.client.delete(self.w(f"pages/{self.page}/"))
        items = self.as_(self.viewer).get(self.w("activity/")).data["items"]
        self.assertEqual(items[0]["text"], "deleted the page \u201cRelease plan\u201d")
        self.assertIsNone(items[0]["url"])
        texts = [i["text"] for i in items]
        self.assertIn("commented on the page \u201cRelease plan\u201d", texts)
        self.assertIn("added the column \u201cPage\u201d to \u201cBugs\u201d", texts)
        self.assertIn("changed Description in row 1 of \u201cBugs\u201d", texts)
        self.assertIn("created the table \u201cBugs\u201d", texts)
        row_item = next(i for i in items if i["text"].startswith("changed Description"))
        self.assertEqual(row_item["url"], f"/workspaces/{self.ws}/tables/{self.tid}/rows/{self.row}")
        self.assertEqual(row_item["actor"], "Eve")

    def test_a_burst_of_saves_is_one_line_of_history(self):
        url = self.w(f"tables/{self.tid}/rows/{self.row}/")
        self.as_(self.editor)
        for text in ("a", "ab", "abc"):
            self.client.patch(url, {"values": {self.desc: text}}, format="json")
        self.client.patch(url, {"values": {self.done: True}}, format="json")
        edits = ActivityEvent.objects.filter(verb="row.edited")
        self.assertEqual(edits.count(), 1)
        self.assertEqual(edits.get().detail["columns"], ["Description", "Done"])
        page = self.client.get(self.w(f"pages/{self.page}/")).data
        for title in ("x", "y"):
            page = self.client.patch(self.w(f"pages/{self.page}/"), {"base_version": page["version"], "title": title}, format="json").data
        self.assertEqual(ActivityEvent.objects.filter(verb="page.edited").count(), 1)
        self.assertEqual(ActivityEvent.objects.get(verb="page.edited").title, "y")

    def test_someone_else_or_a_later_save_starts_a_new_line(self):
        url = self.w(f"tables/{self.tid}/rows/{self.row}/")
        self.as_(self.editor).patch(url, {"values": {self.desc: "a"}}, format="json")
        self.as_(self.admin).patch(url, {"values": {self.desc: "b"}}, format="json")
        self.assertEqual(ActivityEvent.objects.filter(verb="row.edited").count(), 2)
        ActivityEvent.objects.update(created_at=timezone.now() - timedelta(minutes=30))
        self.client.patch(url, {"values": {self.desc: "c"}}, format="json")
        self.assertEqual(ActivityEvent.objects.filter(verb="row.edited").count(), 3)

    def test_saving_without_changing_anything_adds_no_history(self):
        url = self.w(f"tables/{self.tid}/rows/{self.row}/")
        self.as_(self.editor).patch(url, {"values": {self.desc: "Fix login"}}, format="json")
        self.assertFalse(ActivityEvent.objects.filter(verb="row.edited").exists())

    def test_history_can_be_for_one_thing_and_comes_in_pages(self):
        url = self.w(f"tables/{self.tid}/rows/{self.row}/")
        self.as_(self.editor).patch(url, {"values": {self.desc: "x"}}, format="json")
        one = self.client.get(self.w("activity/"), {"row": self.row}).data["items"]
        self.assertEqual({i["text"].split(" ")[0] for i in one}, {"changed", "added"})
        self.assertEqual(self.client.get(self.w("activity/"), {"page": self.page}).data["items"][0]["text"], "created the page \u201cRelease plan\u201d")
        for _ in range(35):
            ActivityEvent.objects.create(workspace_id=self.ws, actor=self.editor, verb="member.joined", created_at=timezone.now())
        first = self.client.get(self.w("activity/")).data
        self.assertEqual((len(first["items"]), first["more"]), (30, True))
        self.assertGreater(len(self.client.get(self.w("activity/"), {"before": first["items"][-1]["id"]}).data["items"]), 0)

    def test_member_changes_are_in_the_history(self):
        self.as_(self.owner).patch(self.w(f"members/{self.viewer.pk}/"), {"role": "editor"}, format="json")
        self.client.delete(self.w(f"members/{self.commenter.pk}/"))
        self.as_(self.viewer).delete(self.w(f"members/{self.viewer.pk}/"))
        texts = [i["text"] for i in self.as_(self.owner).get(self.w("activity/")).data["items"]]
        self.assertEqual(texts[:3], ["left the workspace", "removed Carl from the workspace", "made Vera Editor"])

    def test_rows_count_their_comments(self):
        self.as_(self.editor)
        self.row_comment("One")
        comment = self.row_comment("Two").data["id"]
        table = self.client.get(self.w(f"tables/{self.tid}/")).data
        self.assertEqual(table["rows"][0]["comment_count"], 2)
        version = table["version"]
        self.client.delete(self.w(f"comments/{comment}/"))
        fresh = self.client.get(self.w(f"tables/{self.tid}/"), {"known": version}).data
        self.assertEqual(fresh["rows"][0]["comment_count"], 1)
        saved = self.client.patch(self.w(f"tables/{self.tid}/rows/{self.row}/"), {"values": {self.done: True}}, format="json").data
        self.assertEqual(saved["comment_count"], 1)

    def test_a_comment_cannot_be_on_two_things(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            Comment.objects.create(workspace_id=self.ws, page_id=self.page, row_id=self.row, author=self.owner, body="x")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Comment.objects.create(workspace_id=self.ws, author=self.owner, body="x")

    def test_the_clean_up_keeps_recent_things(self):
        self.as_(self.editor)
        keep = self.page_comment("Keep").data["id"]
        old = self.page_comment("Old").data["id"]
        Comment.all_objects.filter(pk=old).update(deleted_at=timezone.now() - timedelta(days=400))
        note = Notification.objects.create(recipient=self.viewer, workspace_id=self.ws, kind="comment", title="Old", url="/")
        Notification.objects.filter(pk=note.pk).update(created_at=timezone.now() - timedelta(days=400))
        fresh = Notification.objects.create(recipient=self.viewer, workspace_id=self.ws, kind="comment", title="New", url="/")
        ActivityEvent.objects.create(workspace_id=self.ws, verb="member.joined", created_at=timezone.now() - timedelta(days=400))
        prune()
        self.assertTrue(Comment.objects.filter(pk=keep).exists())
        self.assertFalse(Comment.all_objects.filter(pk=old).exists())
        self.assertEqual(list(Notification.objects.filter(recipient=self.viewer)), [fresh])
        self.assertFalse(ActivityEvent.objects.filter(created_at__lt=timezone.now() - timedelta(days=300)).exists())

    def test_an_erased_account_leaves_comments_and_history_readable(self):
        self.as_(self.commenter)
        self.page_comment("Mine")
        purge_account(self.commenter)
        comment = self.as_(self.owner).get(self.w(f"pages/{self.page}/comments/")).data[0]
        self.assertIsNone(comment["author"])
        self.assertEqual(comment["body"], "Mine")
        self.assertEqual(self.client.get(self.w("activity/")).data["items"][0]["actor"], "Someone")
