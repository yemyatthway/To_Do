from datetime import timedelta
from unittest import mock

from django.core import mail
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.cleanup import prune
from apps.users.models import User
from apps.users.services import purge_account

from . import permissions as perms
from .models import Invitation, Membership, Page, Workspace

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
