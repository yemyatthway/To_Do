import shutil
import tempfile
from datetime import timedelta
from unittest import mock

from django.core.signing import BadSignature
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase

from apps.users.cleanup import prune
from apps.users.models import User

from . import files, storage
from .models import Comment, Membership, Page, Workspace, WorkspaceFile

PASSWORD = "CorrectHorse-Battery9!"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 100
MB = 1024 * 1024


class FileTestCase(APITestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        settings = override_settings(FILE_STORAGE="local", FILE_DEV_DIR=self.folder)
        settings.enable()
        self.addCleanup(settings.disable)
        now = timezone.now()
        self.people = {}
        self.workspace = Workspace.objects.create(name="Team")
        for name, role in (("owner", "owner"), ("editor", "editor"), ("commenter", "commenter"), ("viewer", "viewer")):
            user = User.objects.create_user(f"{name}@example.com", PASSWORD, full_name=name.title(), email_verified_at=now)
            Membership.objects.create(workspace=self.workspace, user=user, role=role)
            self.people[name] = user
        self.outsider = User.objects.create_user("out@example.com", PASSWORD, full_name="Out", email_verified_at=now)
        self.other_workspace = Workspace.objects.create(name="Other")
        Membership.objects.create(workspace=self.other_workspace, user=self.outsider, role="owner")
        self.use("editor")

    def use(self, name):
        self.client.force_authenticate(self.people[name] if name in self.people else self.outsider)

    @property
    def url(self):
        return f"/api/workspaces/{self.workspace.pk}/files/"

    def prepare(self, name="shot.png", size=len(PNG), **more):
        return self.client.post(self.url, {"name": name, "size": size, **more}, format="json")

    def put(self, target, body=PNG):
        return APIClient().put(target["url"], data=body, content_type=target["headers"]["Content-Type"])

    def upload(self, name="shot.png", body=PNG, **more):
        """The whole journey, as the app does it."""
        prepared = self.prepare(name, len(body), **more).data
        self.assertEqual(self.put(prepared["upload"], body).status_code, 200)
        if prepared["thumb_upload"]:
            self.assertEqual(self.put(prepared["thumb_upload"]).status_code, 200)
        done = self.client.post(f"{self.url}{prepared['file']['id']}/done/")
        self.assertEqual(done.status_code, 200, done.data)
        return done.data


class UploadTests(FileTestCase):
    def test_upload_journey(self):
        prepared = self.prepare(width=1200, height=800, thumb="webp")
        self.assertEqual(prepared.status_code, 201)
        file = prepared.data["file"]
        self.assertEqual(file["status"], "pending")
        self.assertIsNone(file["url"])
        self.put(prepared.data["upload"])
        self.put(prepared.data["thumb_upload"])
        done = self.client.post(f"{self.url}{file['id']}/done/").data
        self.assertEqual(done["status"], "ready")
        self.assertTrue(done["is_image"])
        self.assertEqual((done["width"], done["height"]), (1200, 800))
        self.assertNotEqual(done["thumb_url"], done["url"])
        read = self.client.get(done["url"])
        self.assertEqual(read.status_code, 200)
        self.assertEqual(b"".join(read.streaming_content), PNG)
        attachment = self.client.get(done["download_url"])
        self.assertIn("attachment", attachment["Content-Disposition"])
        self.assertIn("shot.png", attachment["Content-Disposition"])

    def test_who_can_add(self):
        for name, allowed in (("owner", True), ("editor", True), ("commenter", True), ("viewer", False)):
            self.use(name)
            self.assertEqual(self.prepare().status_code, 201 if allowed else 403, name)
        self.use("outsider")
        self.assertEqual(self.prepare().status_code, 404)

    def test_only_safe_types(self):
        for bad in ("page.html", "vector.svg", "run.exe", "script.js", "noextension", "", "../../.env"):
            self.assertEqual(self.prepare(bad).status_code, 400, bad)
        for good in ("a.PNG", "report.pdf", "data.xlsx", "clip.mp4", "bundle.zip"):
            self.assertEqual(self.prepare(good).status_code, 201, good)

    def test_the_server_decides_the_type_and_paths_are_stripped(self):
        self.prepare("../../evil.png", type="text/html")
        file = WorkspaceFile.objects.latest("id")
        self.assertEqual(file.name, "evil.png")
        self.assertEqual(file.content_type, "image/png")
        self.assertNotIn("evil", file.key)
        self.assertTrue(file.key.startswith(f"w{self.workspace.pk}/"))

    def test_size_limits(self):
        for bad in (0, -5, "12", None, True):
            self.assertEqual(self.prepare(size=bad).status_code, 400, bad)
        self.assertEqual(self.prepare(size=25 * MB + 1).status_code, 400)
        self.assertEqual(self.prepare(size=25 * MB).status_code, 201)

    @override_settings(FILE_USER_QUOTA=100, FILE_TOTAL_QUOTA=1000)
    def test_your_share_and_the_whole_app_have_limits(self):
        self.assertEqual(self.prepare(size=90).status_code, 201)
        response = self.prepare(size=20)
        self.assertEqual(response.status_code, 400)
        self.assertIn("used your", str(response.data))
        self.use("owner")
        WorkspaceFile.objects.create(workspace=self.workspace, name="big", size=900, content_type="x", key="big")
        response = self.prepare(size=50)
        self.assertEqual(response.status_code, 400)
        self.assertIn("file space is full", str(response.data))

    def test_a_renamed_file_cannot_pose_as_an_image(self):
        prepared = self.prepare("fake.png", 30).data
        self.put(prepared["upload"], b"<script>alert(1)</script>     ")
        done = self.client.post(f"{self.url}{prepared['file']['id']}/done/")
        self.assertEqual(done.status_code, 400)
        self.assertFalse(WorkspaceFile.objects.filter(pk=prepared["file"]["id"]).exists())

    def test_finish_believes_storage_not_the_browser(self):
        prepared = self.prepare(size=999).data
        done_url = f"{self.url}{prepared['file']['id']}/done/"
        self.assertEqual(self.client.post(done_url).status_code, 400)  # nothing arrived
        self.put(prepared["upload"])
        self.assertEqual(self.client.post(done_url).data["size"], len(PNG))

    def test_a_bad_thumbnail_is_dropped_but_the_file_stays(self):
        prepared = self.prepare(thumb="webp").data
        self.put(prepared["upload"])
        self.put(prepared["thumb_upload"], b"not a picture at all, nothing like one")
        done = self.client.post(f"{self.url}{prepared['file']['id']}/done/").data
        self.assertEqual(done["thumb_url"], done["url"])
        self.assertEqual(WorkspaceFile.objects.get(pk=done["id"]).thumb_key, "")

    def test_a_non_image_is_never_shown_as_one(self):
        done = self.upload("notes.txt", b"hello")
        self.assertFalse(done["is_image"])
        self.assertEqual(done["status"], "ready")

    def test_only_the_uploader_can_finish_retry_or_cancel(self):
        file = self.prepare().data["file"]["id"]
        self.use("owner")
        for response in (self.client.post(f"{self.url}{file}/done/"), self.client.post(f"{self.url}{file}/"), self.client.delete(f"{self.url}{file}/")):
            self.assertEqual(response.status_code, 403)
        self.use("editor")
        self.assertIn("upload", self.client.post(f"{self.url}{file}/").data)
        self.assertEqual(self.client.delete(f"{self.url}{file}/").status_code, 204)
        self.assertFalse(WorkspaceFile.objects.filter(pk=file).exists())

    def test_a_finished_file_cannot_be_cancelled(self):
        done = self.upload()
        self.assertEqual(self.client.delete(f"{self.url}{done['id']}/").status_code, 400)
        self.assertEqual(self.client.post(f"{self.url}{done['id']}/done/").status_code, 200)

    @override_settings(FILE_STORAGE="")
    def test_no_storage_means_a_clear_answer(self):
        response = self.prepare()
        self.assertEqual(response.status_code, 503)
        self.assertIn("set up", str(response.data))


class ReadingTests(FileTestCase):
    def test_members_read_outsiders_do_not(self):
        done = self.upload()
        self.use("viewer")
        listed = self.client.get(f"{self.url}?ids={done['id']}").data
        self.assertEqual(listed[0]["id"], done["id"])
        self.assertTrue(listed[0]["url"])
        self.use("outsider")
        self.assertEqual(self.client.get(f"{self.url}?ids={done['id']}").status_code, 404)
        other = f"/api/workspaces/{self.other_workspace.pk}/files/?ids={done['id']}"
        self.assertEqual(self.client.get(other).data, [])

    def test_bad_lists(self):
        self.assertEqual(self.client.get(f"{self.url}?ids=a,b").status_code, 400)
        many = ",".join(str(i) for i in range(1, 102))
        self.assertEqual(self.client.get(f"{self.url}?ids={many}").status_code, 400)
        self.assertEqual(self.client.get(self.url).data, [])

    def test_a_pending_file_has_no_links(self):
        file = self.prepare().data["file"]["id"]
        self.assertIsNone(self.client.get(f"{self.url}?ids={file}").data[0]["url"])

    def test_a_tampered_or_wrong_kind_of_link_fails(self):
        done = self.upload()
        self.assertEqual(APIClient().get(done["url"][:-3] + "xx/").status_code, 404)
        prepared = self.prepare().data
        self.assertEqual(APIClient().get(prepared["upload"]["url"]).status_code, 404)
        self.assertEqual(APIClient().put(done["url"], data=b"x", content_type="image/png").status_code, 404)

    def test_an_upload_link_cannot_overwrite(self):
        prepared = self.prepare().data
        self.put(prepared["upload"])
        self.assertEqual(self.put(prepared["upload"], b"other").status_code, 409)

    def test_a_local_key_cannot_leave_its_folder(self):
        with self.assertRaises(ValueError):
            storage._local_path("../outside.txt")
        with self.assertRaises(BadSignature):
            storage.read_dev_token("nonsense", "get", 60)

    @override_settings(FILE_STORAGE="supabase")
    def test_local_links_are_off_in_production(self):
        self.assertEqual(APIClient().get("/api/workspaces/files/dev/abc/").status_code, 404)


class UsingFilesTests(FileTestCase):
    def page(self):
        return Page.objects.create(workspace=self.workspace, title="Notes")

    def save(self, page, blocks):
        return self.client.patch(f"/api/workspaces/{self.workspace.pk}/pages/{page.pk}/", {"base_version": page.version, "blocks": blocks}, format="json")

    def test_a_page_holds_its_own_files_only(self):
        page = self.page()
        mine = self.upload()["id"]
        foreign = WorkspaceFile.objects.create(workspace=self.other_workspace, name="x.png", size=1, content_type="image/png", key="foreign")
        response = self.save(page, [{"id": "a", "type": "file", "text": "ignored", "file": mine}, {"id": "b", "type": "file", "text": "", "file": foreign.pk}, {"id": "c", "type": "p", "text": "hi"}])
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["blocks"], [{"id": "a", "type": "file", "text": "", "file": mine}, {"id": "c", "type": "p", "text": "hi"}])

    def test_a_file_block_needs_a_file_id(self):
        page = self.page()
        for bad in (None, "1", True, 1.5):
            self.assertEqual(self.save(page, [{"id": "a", "type": "file", "text": "", "file": bad}]).status_code, 400, bad)

    def test_table_cells_hold_files(self):
        base = f"/api/workspaces/{self.workspace.pk}/tables/"
        table = self.client.post(base, {"title": "Bugs"}, format="json").data["id"]
        column = self.client.post(f"{base}{table}/columns/", {"name": "Screenshot", "type": "file"}, format="json").data["columns"][-1]
        self.assertEqual(column["type"], "file")
        row = self.client.post(f"{base}{table}/rows/", {}, format="json").data["id"]
        first, second = self.upload()["id"], self.upload()["id"]
        saved = self.client.patch(f"{base}{table}/rows/{row}/", {"values": {column["id"]: [first, second, first, 999999]}}, format="json")
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data["values"][column["id"]], [first, second])
        self.assertEqual(self.client.patch(f"{base}{table}/rows/{row}/", {"values": {column["id"]: "nope"}}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(f"{base}{table}/rows/{row}/", {"values": {column["id"]: list(range(1, 12))}}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(f"{base}{table}/rows/{row}/", {"values": {column["id"]: None}}, format="json").data["values"][column["id"]], [])

    def test_a_comment_can_be_just_a_file(self):
        page = self.page()
        url = f"/api/workspaces/{self.workspace.pk}/pages/{page.pk}/comments/"
        file = self.upload()["id"]
        self.use("commenter")
        made = self.client.post(url, {"body": "", "files": [file]}, format="json")
        self.assertEqual(made.status_code, 201, made.data)
        self.assertEqual(made.data["files"], [file])
        self.assertEqual(self.client.get(url).data[0]["files"], [file])
        self.assertEqual(self.client.post(url, {"body": "", "files": [999999]}, format="json").status_code, 400)
        self.assertEqual(self.client.post(url, {"body": "x", "files": "1"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(url, {"body": "x", "files": list(range(1, 8))}, format="json").status_code, 400)
        self.assertEqual(self.client.post(url, {"body": "text only"}, format="json").data["files"], [])


class CleanupTests(FileTestCase):
    def age(self, file_id, **age):
        WorkspaceFile.objects.filter(pk=file_id).update(created_at=timezone.now() - timedelta(**age))

    def stored(self, file_id):
        return storage.peek(WorkspaceFile.objects.get(pk=file_id).key) is not None

    def test_unfinished_uploads_go_after_a_day(self):
        prepared = self.prepare().data
        file = prepared["file"]["id"]
        self.put(prepared["upload"])
        key = WorkspaceFile.objects.get(pk=file).key
        self.assertEqual(files.prune(), 0)
        self.age(file, hours=25)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(files.prune(), 1)
        self.assertFalse(WorkspaceFile.objects.filter(pk=file).exists())
        self.assertIsNone(storage.peek(key))

    def test_unused_files_go_after_a_month_and_used_ones_stay(self):
        loose, on_page, on_deleted_page, on_comment, recent = [self.upload()["id"] for _ in range(5)]
        page = Page.objects.create(workspace=self.workspace, title="A", blocks=[{"id": "a", "type": "file", "text": "", "file": on_page}])
        Page.objects.create(workspace=self.workspace, title="B", deleted_at=timezone.now(), blocks=[{"id": "a", "type": "file", "text": "", "file": on_deleted_page}])
        Comment.objects.create(workspace=self.workspace, page=page, body="", files=[on_comment])
        for file in (loose, on_page, on_deleted_page, on_comment):
            self.age(file, days=31)
        self.assertEqual(files.prune(), 1)
        self.assertEqual(set(WorkspaceFile.objects.values_list("pk", flat=True)), {on_page, on_deleted_page, on_comment, recent})

    def test_files_in_a_table_stay(self):
        base = f"/api/workspaces/{self.workspace.pk}/tables/"
        table = self.client.post(base, {"title": "Bugs"}, format="json").data["id"]
        column = self.client.post(f"{base}{table}/columns/", {"name": "Shot", "type": "file"}, format="json").data["columns"][-1]["id"]
        row = self.client.post(f"{base}{table}/rows/", {}, format="json").data["id"]
        file = self.upload()["id"]
        self.client.patch(f"{base}{table}/rows/{row}/", {"values": {column: [file]}}, format="json")
        self.age(file, days=31)
        self.assertEqual(files.prune(), 0)

    def test_a_deleted_workspace_takes_its_stored_files(self):
        key = WorkspaceFile.objects.get(pk=self.upload()["id"]).key
        Workspace.all_objects.filter(pk=self.workspace.pk).update(deleted_at=timezone.now() - timedelta(days=31))
        with self.captureOnCommitCallbacks(execute=True):
            prune()
        self.assertFalse(WorkspaceFile.objects.filter(key=key).exists())
        self.assertIsNone(storage.peek(key))

    def test_a_storage_failure_never_stops_cleanup(self):
        file = self.upload()["id"]
        self.age(file, days=31)
        with mock.patch("apps.workspaces.storage.remove", side_effect=OSError("down")), self.assertLogs("apps.workspaces.storage", "ERROR"), self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(files.prune(), 1)


def response_of(status=200, payload=None, headers=None, body=b""):
    response = mock.MagicMock(status_code=status, ok=status < 400, headers=headers or {})
    response.json.return_value = payload
    response.iter_content.return_value = iter([body])
    response.__enter__.return_value = response
    return response


@override_settings(FILE_STORAGE="supabase", SUPABASE_URL="https://proj.supabase.co/", SUPABASE_SECRET_KEY="secret", SUPABASE_BUCKET="bucket")
class SupabaseTests(APITestCase):
    """The calls Supabase's own client makes. Real uploads can only be checked once the key is on the server."""

    @mock.patch("apps.workspaces.storage.requests.post")
    def test_upload_link(self, post):
        post.return_value = response_of(payload={"url": "/object/upload/sign/bucket/w1/a b.png?token=t"})
        target = storage.upload_target("w1/a b.png", "image/png")
        self.assertEqual(target["url"], "https://proj.supabase.co/storage/v1/object/upload/sign/bucket/w1/a b.png?token=t")
        self.assertEqual(target["headers"]["Content-Type"], "image/png")
        self.assertEqual(post.call_args.args[0], "https://proj.supabase.co/storage/v1/object/upload/sign/bucket/w1/a%20b.png")
        self.assertEqual(post.call_args.kwargs["headers"]["Authorization"], "Bearer secret")

    @mock.patch("apps.workspaces.storage.requests.post")
    def test_read_links_skip_failures(self, post):
        post.return_value = response_of(payload=[{"path": "a", "signedURL": "/object/sign/bucket/a?token=t"}, {"path": "b", "signedURL": None, "error": "gone"}])
        self.assertEqual(storage.sign(["a", "b"], 60), {"a": "https://proj.supabase.co/storage/v1/object/sign/bucket/a?token=t"})
        self.assertEqual(post.call_args.kwargs["json"], {"expiresIn": 60, "paths": ["a", "b"]})
        self.assertEqual(storage.sign([], 60), {})

    @mock.patch("apps.workspaces.storage.requests.get")
    def test_peek_reads_the_real_size(self, get):
        get.return_value = response_of(206, headers={"Content-Range": "bytes 0-31/5000"}, body=PNG[:32])
        self.assertEqual(storage.peek("a"), (5000, PNG[:32]))
        self.assertEqual(get.call_args.kwargs["headers"]["Range"], "bytes=0-31")
        get.return_value = response_of(200, headers={"Content-Length": "40"}, body=b"x" * 40)
        self.assertEqual(storage.peek("a"), (40, b"x" * 32))
        get.return_value = response_of(404)
        self.assertIsNone(storage.peek("a"))

    @mock.patch("apps.workspaces.storage.requests.delete")
    def test_remove(self, delete):
        delete.return_value = response_of()
        storage.remove(["a", "", "b"])
        self.assertEqual(delete.call_args.kwargs["json"], {"prefixes": ["a", "b"]})
        delete.reset_mock()
        storage.remove([""])
        delete.assert_not_called()

    def test_download_link_joins_the_name_safely(self):
        file = WorkspaceFile(pk=1, name="my report & notes.pdf", key="a", size=1, status="ready", content_type="x")
        data = files._file_data(file, {"a": "https://x/a?token=t"}, timezone.now())
        self.assertEqual(data["download_url"], "https://x/a?token=t&download=my%20report%20%26%20notes.pdf")

    @mock.patch("apps.workspaces.storage.requests.post")
    def test_a_storage_outage_leaves_no_record(self, post):
        import requests

        post.side_effect = requests.ConnectionError()
        user = User.objects.create_user("o@example.com", PASSWORD, full_name="O", email_verified_at=timezone.now())
        workspace = Workspace.objects.create(name="T")
        Membership.objects.create(workspace=workspace, user=user, role="owner")
        self.client.force_authenticate(user)
        response = self.client.post(f"/api/workspaces/{workspace.pk}/files/", {"name": "a.png", "size": 10}, format="json")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(WorkspaceFile.objects.count(), 0)
