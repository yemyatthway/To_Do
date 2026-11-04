from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.models import User

from . import services
from .models import ActivityEvent, Membership, Table, TableRow, Workspace

PASSWORD = "CorrectHorse-Battery9!"


def person(name):
    return User.objects.create_user(f"{name}@example.com", PASSWORD, full_name=name.title(), email_verified_at=timezone.now())


@override_settings(EMAIL_SEND_ASYNC=False, PUSH_SEND_ASYNC=False)
class ImportTableTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.owner, self.viewer, self.outsider = person("olivia"), person("victor"), person("omar")
        self.workspace = Workspace.objects.create(name="Dev Team")
        Membership.objects.create(workspace=self.workspace, user=self.owner, role="owner")
        Membership.objects.create(workspace=self.workspace, user=self.viewer, role="viewer")
        self.client.force_authenticate(self.owner)
        self.url = f"/api/workspaces/{self.workspace.pk}/tables/import/"
        self.columns = [
            {"name": "Task", "type": "text"}, {"name": "Hours", "type": "number"},
            {"name": "Due", "type": "date"}, {"name": "Done", "type": "checkbox"},
        ]

    def send(self, columns=None, rows=None, title="Bugs", **extra):
        return self.client.post(
            self.url, {"title": title, "columns": self.columns if columns is None else columns, "rows": [] if rows is None else rows}, format="json", **extra,
        )

    def test_makes_the_exact_columns_and_rows(self):
        response = self.send(rows=[["Login", 2.5, "2026-11-04T03:00:00.000Z", True], ["Chat", None, None, False]])
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual([c["name"] for c in response.data["columns"]], ["Task", "Hours", "Due", "Done"])
        rows = response.data["rows"]
        self.assertEqual([r["no"] for r in rows], [1, 2])
        ids = [c["id"] for c in response.data["columns"]]
        self.assertEqual(rows[0]["values"][ids[0]], "Login")
        self.assertEqual(rows[0]["values"][ids[1]], 2.5)
        self.assertTrue(rows[0]["values"][ids[2]].startswith("2026-11-04T03:00"))
        self.assertIs(rows[0]["values"][ids[3]], True)
        self.assertEqual(rows[1]["values"][ids[1]], None)
        self.assertEqual(Table.objects.get(pk=response.data["id"]).next_no, 3)

    def test_a_short_row_fills_up_with_empty_cells(self):
        response = self.send(rows=[["Only the first"]])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(response.data["rows"][0]["values"]), 4)

    def test_only_a_header_makes_an_empty_table(self):
        response = self.send()
        self.assertEqual((response.status_code, response.data["rows"]), (201, []))

    def test_new_rows_continue_after_the_imported_ones(self):
        table = self.send(rows=[["a"], ["b"]]).data
        row = self.client.post(f"/api/workspaces/{self.workspace.pk}/tables/{table['id']}/rows/", {"values": {}}, format="json")
        self.assertEqual(row.data["no"], 3)

    def test_viewers_and_outsiders_cannot_import(self):
        self.client.force_authenticate(self.viewer)
        self.assertEqual(self.send().status_code, 403)
        self.client.force_authenticate(self.outsider)
        self.assertEqual(self.send().status_code, 404)
        self.client.force_authenticate(None)
        self.assertEqual(self.send().status_code, 401)
        self.assertFalse(Table.objects.exists())

    def test_refuses_too_many_columns_or_rows_with_the_real_counts(self):
        response = self.send(columns=[{"name": f"C{i}", "type": "text"} for i in range(31)])
        self.assertEqual(response.status_code, 400)
        self.assertIn("31 columns", str(response.data))
        response = self.send(rows=[["x"]] * 2001)
        self.assertEqual(response.status_code, 400)
        self.assertIn("2,001 rows", str(response.data))
        self.assertFalse(Table.objects.exists())

    def test_a_bad_cell_leaves_nothing_behind(self):
        for row in (["x", "not a number"], ["x", 1, "not a date"], ["x", 1, None, "maybe"], ["y" * (services.MAX_CELL_TEXT + 1)], [{"a": 1}], ["a", 1, None, True, "extra"]):
            self.assertEqual(self.send(rows=[["fine"], row]).status_code, 400, row)
        self.assertFalse(Table.objects.exists())
        self.assertFalse(TableRow.objects.exists())

    def test_only_simple_column_kinds_can_be_imported(self):
        for kind in ("person", "file", "select", "nonsense", None):
            self.assertEqual(self.send(columns=[{"name": "A", "type": kind}]).status_code, 400, kind)

    def test_refuses_bad_shapes(self):
        for columns, rows in (([], []), ("x", []), (self.columns, "x"), (self.columns, ["x"]), (["x"], []), ([{"name": "", "type": "text"}], [])):
            self.assertEqual(self.send(columns=columns, rows=rows).status_code, 400, (columns, rows))
        self.assertEqual(self.client.post(self.url, [1, 2], format="json").status_code, 400)

    def test_refuses_an_oversized_body_before_reading_it(self):
        response = self.send(CONTENT_LENGTH=str(services.MAX_IMPORT_BYTES + 1))
        self.assertEqual(response.status_code, 400)
        self.assertIn("too much data", str(response.data))

    def test_stops_at_the_room_for_table_data(self):
        self.assertEqual(self.send(rows=[["some text"]]).status_code, 201)
        original = services.MAX_TABLE_DATA_PER_PERSON
        services.MAX_TABLE_DATA_PER_PERSON = 1
        self.addCleanup(setattr, services, "MAX_TABLE_DATA_PER_PERSON", original)
        response = self.send(rows=[["more"]])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Table.objects.count(), 1)

    def test_workspace_table_limit_still_applies(self):
        original = services.MAX_TABLES
        services.MAX_TABLES = 1
        self.addCleanup(setattr, services, "MAX_TABLES", original)
        self.assertEqual(self.send().status_code, 201)
        self.assertEqual(self.send().status_code, 400)

    def test_a_formula_is_only_ever_text(self):
        response = self.send(rows=[['=HYPERLINK("http://x")']])
        ids = response.data["columns"][0]["id"]
        self.assertEqual(response.data["rows"][0]["values"][ids], '=HYPERLINK("http://x")')

    def test_the_activity_shows_one_new_table_not_every_row(self):
        self.assertEqual(self.send(rows=[["a"], ["b"], ["c"]]).status_code, 201)
        events = ActivityEvent.objects.filter(workspace=self.workspace)
        self.assertEqual(list(events.values_list("verb", flat=True)), ["table.created"])
