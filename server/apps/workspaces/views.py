from django.db.models import Count
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.social.services import mask_email
from apps.users.language import tr

from . import files
from . import permissions as perms
from . import services
from .models import Membership, Notification


def member_data(membership):
    user = membership.user
    return {
        "id": user.pk, "full_name": user.full_name, "username": user.username, "email": mask_email(user.email),
        "role": membership.role, "joined_at": membership.joined_at,
    }


def summary_data(membership, member_count=None, unread=0):
    workspace = membership.workspace
    return {
        "id": workspace.pk, "name": workspace.name, "role": membership.role, "created_at": workspace.created_at,
        "member_count": member_count if member_count is not None else services.members_of(workspace).count(),
        "unread": unread,
    }


def detail_data(membership):
    workspace = membership.workspace
    data = summary_data(membership)
    data["can"] = perms.abilities(membership.role)
    data["assignable_roles"] = perms.ASSIGNABLE
    data["members"] = [member_data(m) for m in services.members_of(workspace)]
    # Only people who can manage members see who's been invited.
    data["invitations"] = (
        [
            {"id": i.pk, "label": i.label, "role": i.role, "created_at": i.created_at, "expires_at": i.expires_at, "guest_url": services.guest_url(i)}
            for i in services.pending_invitations(workspace)
        ]
        if perms.can(membership.role, perms.MANAGE_MEMBERS)
        else []
    )
    return data


def invitation_data(invitation):
    inviter = invitation.invited_by
    return {
        "id": invitation.pk, "workspace": invitation.workspace.name, "role": invitation.role, "expires_at": invitation.expires_at,
        "invited_by": (inviter.full_name or f"@{inviter.username}") if inviter else "Someone",
    }


class WorkspacesApi(APIView):
    """GET: your workspaces and invitations waiting for you. POST {name}: create one (you own it)."""

    def get(self, request):
        me = request.user
        memberships = Membership.objects.filter(user=me, workspace__deleted_at__isnull=True).select_related("workspace").order_by("workspace__name")
        unread = dict(Notification.objects.filter(recipient=me, read_at__isnull=True).order_by().values_list("workspace").annotate(Count("id")))
        return Response({
            "workspaces": [summary_data(m, unread=unread.get(m.workspace_id, 0)) for m in memberships],
            "invitations": [invitation_data(i) for i in services.my_invitations(me)],
        })

    def post(self, request):
        workspace = services.create(request.user, request.data.get("name"))
        return Response(detail_data(services.membership_for(request.user, workspace.pk)), status=status.HTTP_201_CREATED)


class WorkspaceApi(APIView):
    def get(self, request, workspace_id):
        return Response(detail_data(services.membership_for(request.user, workspace_id)))

    def patch(self, request, workspace_id):
        services.rename(request.user, workspace_id, request.data.get("name"))
        return Response(detail_data(services.membership_for(request.user, workspace_id)))

    def delete(self, request, workspace_id):
        services.delete(request.user, workspace_id, request.data.get("confirm_name"))
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceInvitationsApi(APIView):
    throttle_scope = "workspace_invite"

    def post(self, request, workspace_id):
        services.invite(request.user, workspace_id, request.data.get("invitee"), request.data.get("role"))
        return Response(detail_data(services.membership_for(request.user, workspace_id)), status=status.HTTP_201_CREATED)


class WorkspaceInvitationApi(APIView):
    def delete(self, request, workspace_id, invitation_id):
        services.cancel_invitation(request.user, workspace_id, invitation_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AcceptInvitationApi(APIView):
    def post(self, request, invitation_id):
        return Response(detail_data(services.accept(request.user, invitation_id)))


class DeclineInvitationApi(APIView):
    def post(self, request, invitation_id):
        services.decline(request.user, invitation_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MemberApi(APIView):
    """PATCH {role}: change someone's role. DELETE: remove them, or yourself to leave."""

    def patch(self, request, workspace_id, user_id):
        services.set_role(request.user, workspace_id, user_id, request.data.get("role"))
        return Response(detail_data(services.membership_for(request.user, workspace_id)))

    def delete(self, request, workspace_id, user_id):
        services.remove_member(request.user, workspace_id, user_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TransferApi(APIView):
    def post(self, request, workspace_id):
        services.transfer(request.user, workspace_id, request.data.get("user_id"))
        return Response(detail_data(services.membership_for(request.user, workspace_id)))


def page_summary(page):
    editor = page.updated_by
    return {
        "id": page.pk, "title": page.title, "version": page.version, "updated_at": page.updated_at,
        "updated_by": (editor.full_name or f"@{editor.username}") if editor else None,
    }


def page_data(page):
    return {**page_summary(page), "blocks": page.blocks}


class PagesApi(APIView):
    """GET: the workspace's pages, newest first (no content). POST {title}: create one."""

    def get(self, request, workspace_id):
        return Response([page_summary(p) for p in services.pages_of(request.user, workspace_id)])

    def post(self, request, workspace_id):
        page = services.create_page(request.user, workspace_id, request.data.get("title"))
        return Response(page_data(page), status=status.HTTP_201_CREATED)


class PageApi(APIView):
    """GET: one page. PATCH {base_version, title?, blocks?}: save it, or 409 with `current` if
    someone saved first. DELETE: move it to the bin."""

    throttle_scope = "pages"

    def get(self, request, workspace_id, page_id):
        return Response(page_data(services.page_for(request.user, workspace_id, page_id)))

    def patch(self, request, workspace_id, page_id):
        try:
            page = services.update_page(request.user, workspace_id, page_id, request.data.get("base_version"), request.data.get("title"), request.data.get("blocks"))
        except services.PageConflict as conflict:
            return Response({"detail": "Someone else changed this page.", "current": page_data(conflict.current)}, status=status.HTTP_409_CONFLICT)
        return Response(page_data(page))

    def delete(self, request, workspace_id, page_id):
        services.delete_page(request.user, workspace_id, page_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RestorePageApi(APIView):
    def post(self, request, workspace_id, page_id):
        return Response(page_data(services.restore_page(request.user, workspace_id, page_id)))


def table_summary(table):
    editor = table.updated_by
    return {
        "id": table.pk, "title": table.title, "version": table.version, "updated_at": table.updated_at,
        "updated_by": (editor.full_name or f"@{editor.username}") if editor else None,
    }


def row_data(row, columns, on_my_tasks=False, comment_count=0):
    known = {c["id"] for c in columns}
    return {
        "id": row.pk, "no": row.no, "values": {k: v for k, v in row.values.items() if k in known},
        "highlighted": row.highlighted, "on_my_tasks": on_my_tasks, "comment_count": comment_count,
    }


def one_row(row, me):
    return row_data(row, row.table.columns, row.pk in services.my_tasks_from(me, row.table), services.comment_counts(row.table).get(row.pk, 0))


def table_data(table, me):
    mine = services.my_tasks_from(me, table)
    counts = services.comment_counts(table)
    return {
        **table_summary(table), "description": table.description, "columns": table.columns,
        "rows": [row_data(r, table.columns, r.pk in mine, counts.get(r.pk, 0)) for r in services.rows_of(table)],
    }


class TablesApi(APIView):
    """GET: the workspace's tables, newest first (no rows). POST {title}: create one."""

    def get(self, request, workspace_id):
        return Response([table_summary(t) for t in services.tables_of(request.user, workspace_id)])

    def post(self, request, workspace_id):
        table = services.create_table(request.user, workspace_id, request.data.get("title"))
        return Response(table_data(table, request.user), status=status.HTTP_201_CREATED)


class ImportTableApi(APIView):
    """POST {title, columns: [{name, type}], rows: [[cell, ...]]}: a new table from a spreadsheet."""

    throttle_scope = "table_import"

    def post(self, request, workspace_id):
        # Before reading the body, so an oversized one is never loaded into memory.
        try:
            size = int(request.META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            size = 0
        if size > services.MAX_IMPORT_BYTES:
            raise ValidationError({"rows": ["This file has too much data to import."]})
        data = request.data if isinstance(request.data, dict) else {}
        table = services.import_table(request.user, workspace_id, data.get("title"), data.get("columns"), data.get("rows"))
        return Response(table_data(table, request.user), status=status.HTTP_201_CREATED)


class TableApi(APIView):
    """GET: the table and its rows; with ?known=<version>, only "unchanged" if nothing moved, so
    open screens can check often for almost nothing. PATCH {title?, description?}. DELETE: to the bin."""

    throttle_scope = "tables"

    def get(self, request, workspace_id, table_id):
        table = services.table_for(request.user, workspace_id, table_id)
        if request.query_params.get("known") == str(table.version):
            return Response({"unchanged": True})
        return Response(table_data(table, request.user))

    def patch(self, request, workspace_id, table_id):
        table = services.update_table(request.user, workspace_id, table_id, request.data.get("title"), request.data.get("description"))
        return Response(table_data(table, request.user))

    def delete(self, request, workspace_id, table_id):
        services.delete_table(request.user, workspace_id, table_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RestoreTableApi(APIView):
    def post(self, request, workspace_id, table_id):
        return Response(table_data(services.restore_table(request.user, workspace_id, table_id), request.user))


class ColumnsApi(APIView):
    def post(self, request, workspace_id, table_id):
        table = services.add_column(request.user, workspace_id, table_id, request.data.get("name"), request.data.get("type"))
        return Response(table_data(table, request.user), status=status.HTTP_201_CREATED)


class ColumnApi(APIView):
    def patch(self, request, workspace_id, table_id, column_id):
        table = services.update_column(request.user, workspace_id, table_id, column_id, request.data.get("name"), request.data.get("position"))
        return Response(table_data(table, request.user))

    def delete(self, request, workspace_id, table_id, column_id):
        return Response(table_data(services.delete_column(request.user, workspace_id, table_id, column_id), request.user))


class RowsApi(APIView):
    throttle_scope = "tables"

    def post(self, request, workspace_id, table_id):
        row = services.create_row(request.user, workspace_id, table_id, request.data.get("values"))
        return Response(one_row(row, request.user), status=status.HTTP_201_CREATED)


class RowApi(APIView):
    """PATCH {values, base?, highlighted?}: change those cells, or 409 with `current` if someone
    changed one of them since `base`. DELETE: to the bin."""

    throttle_scope = "tables"

    def patch(self, request, workspace_id, table_id, row_id):
        try:
            row = services.update_row(request.user, workspace_id, table_id, row_id, request.data.get("values"), request.data.get("base"), request.data.get("highlighted"))
        except services.RowConflict as conflict:
            current = conflict.current
            return Response(
                {"detail": "Someone else changed this row.", "current": one_row(current, request.user)},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(one_row(row, request.user))

    def delete(self, request, workspace_id, table_id, row_id):
        services.delete_row(request.user, workspace_id, table_id, row_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RestoreRowApi(APIView):
    def post(self, request, workspace_id, table_id, row_id):
        row = services.restore_row(request.user, workspace_id, table_id, row_id)
        return Response(one_row(row, request.user))


class AddRowToTasksApi(APIView):
    def post(self, request, workspace_id, table_id, row_id):
        row, task = services.add_row_to_tasks(request.user, workspace_id, table_id, row_id)
        return Response({"row": one_row(row, request.user), "task_title": task.title, "due_at": task.due_at})


def comment_data(comment, me, can_manage):
    author = comment.author
    return {
        "id": comment.pk, "body": comment.body, "created_at": comment.created_at,
        "author": {"id": author.pk, "name": author.full_name or f"@{author.username}", "username": author.username} if author else None,
        "can_delete": can_manage or (author is not None and author.pk == me.pk),
        "files": comment.files,
    }


def _comments_response(request, workspace_id, comments):
    can_manage = perms.can(services.membership_for(request.user, workspace_id).role, perms.MANAGE_MEMBERS)
    return Response([comment_data(c, request.user, can_manage) for c in comments])


class PageCommentsApi(APIView):
    throttle_scope = "comments"

    def get(self, request, workspace_id, page_id):
        return _comments_response(request, workspace_id, services.comments_of(request.user, workspace_id, page_id=page_id))

    def post(self, request, workspace_id, page_id):
        comment = services.add_comment(request.user, workspace_id, request.data.get("body"), page_id=page_id, file_ids=request.data.get("files"))
        can_manage = perms.can(services.membership_for(request.user, workspace_id).role, perms.MANAGE_MEMBERS)
        return Response(comment_data(comment, request.user, can_manage), status=status.HTTP_201_CREATED)


class RowCommentsApi(APIView):
    throttle_scope = "comments"

    def get(self, request, workspace_id, table_id, row_id):
        return _comments_response(request, workspace_id, services.comments_of(request.user, workspace_id, table_id=table_id, row_id=row_id))

    def post(self, request, workspace_id, table_id, row_id):
        comment = services.add_comment(request.user, workspace_id, request.data.get("body"), table_id=table_id, row_id=row_id, file_ids=request.data.get("files"))
        can_manage = perms.can(services.membership_for(request.user, workspace_id).role, perms.MANAGE_MEMBERS)
        return Response(comment_data(comment, request.user, can_manage), status=status.HTTP_201_CREATED)


class CommentApi(APIView):
    def delete(self, request, workspace_id, comment_id):
        services.delete_comment(request.user, workspace_id, comment_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


def _quoted(text):
    return f"\u201c{text}\u201d" if text else ""


ACTIVITY_LINES = {
    "workspace.renamed": "renamed the workspace to {title}",
    "member.joined": "joined the workspace",
    "member.left": "left the workspace",
    "member.removed": "removed {name} from the workspace",
    "member.role": "made {name} {role}",
    "page.created": "created the page {title}",
    "page.edited": "edited the page {title}",
    "page.deleted": "deleted the page {title}",
    "page.restored": "brought back the page {title}",
    "table.created": "created the table {title}",
    "table.renamed": "renamed a table to {title}",
    "table.deleted": "deleted the table {title}",
    "table.restored": "brought back the table {title}",
    "column.added": "added the column {column} to {title}",
    "column.renamed": "renamed {was} to {column} in {title}",
    "column.removed": "removed the column {column} from {title}",
    "row.created": "added row {no} of {title}",
    "row.edited": "changed {columns} in row {no} of {title}",
    "row.deleted": "deleted row {no} of {title}",
    "row.restored": "brought back row {no} of {title}",
    "comment.page": "commented on the page {title}",
    "comment.row": "commented on row {no} of {title}",
}


def activity_text(event, language="en"):
    """One line of history, in words, in the reader's language."""
    detail = event.detail
    return tr(
        language,
        ACTIVITY_LINES.get(event.verb, "changed something"),
        title=_quoted(event.title),
        name=event.title,
        role=tr(language, str(detail.get("role", "")).capitalize()),
        column=_quoted(detail.get("column", "")),
        was=_quoted(detail.get("was", "")),
        no=detail.get("no"),
        columns=", ".join(detail.get("columns", [])),
    )


def activity_url(event):
    base = f"/workspaces/{event.workspace_id}"
    if event.verb.endswith(".deleted"):
        return None
    if event.target_kind == "page":
        return f"{base}/pages/{event.target_id}"
    if event.target_kind == "table":
        return f"{base}/tables/{event.target_id}"
    if event.target_kind == "row":
        return f"{base}/tables/{event.detail.get('table_id')}/rows/{event.target_id}"
    return None


def activity_data(event, language="en"):
    actor = event.actor
    return {
        "id": event.pk, "created_at": event.created_at, "text": activity_text(event, language), "url": activity_url(event),
        "actor": (actor.full_name or f"@{actor.username}") if actor else "Someone",
    }


def _int_param(request, name):
    value = request.query_params.get(name)
    return int(value) if value and value.isdigit() else None


class ActivityApi(APIView):
    """GET: the workspace's history, newest first, ?before=<id> for more, ?page= or ?row= for one thing.
    With ?number=<n> it's the Activity screen instead, a page at a time, narrowed by ?q=, ?actor=<id>,
    ?kind=pages|tables|rows|comments|people and ?since=<iso>."""

    def get(self, request, workspace_id):
        language = request.user.language
        number = _int_param(request, "number")
        if number is not None:
            since = parse_datetime(request.query_params.get("since") or "")
            events, number, pages = services.activity_page(
                request.user, workspace_id, number, request.query_params.get("q", ""), _int_param(request, "actor"), request.query_params.get("kind", ""), since,
            )
            return Response({"items": [activity_data(e, language) for e in events], "number": number, "pages": pages})
        events = services.activity_of(request.user, workspace_id, _int_param(request, "before"), _int_param(request, "page"), _int_param(request, "row"))
        return Response({"items": [activity_data(e, language) for e in events[: services.PAGE_SIZE]], "more": len(events) > services.PAGE_SIZE})


def notification_data(item):
    actor = item.actor
    return {
        "id": item.pk, "kind": item.kind, "title": item.title, "body": item.body, "url": item.url, "read": item.read_at is not None, "created_at": item.created_at,
        "actor": (actor.full_name or f"@{actor.username}") if actor else "Someone",
    }


class NotificationsApi(APIView):
    """GET: what's for you, newest first, with how many are unread. ?before=<id> for more."""

    def get(self, request):
        items, unread = services.notifications_of(request.user, _int_param(request, "before"))
        return Response({"items": [notification_data(n) for n in items[: services.PAGE_SIZE]], "unread": unread, "more": len(items) > services.PAGE_SIZE})


class ReadNotificationsApi(APIView):
    """POST {ids: [...]} or {workspace: id}: mark those as read. With neither: mark everything."""

    def post(self, request):
        services.mark_read(request.user, request.data.get("ids"), request.data.get("workspace"))
        return Response(status=status.HTTP_204_NO_CONTENT)


def _upload_response(file, targets, status_code=status.HTTP_200_OK):
    return Response({"file": files.data_for([file])[0], **targets}, status=status_code)


class FilesApi(APIView):
    """GET ?ids=1,2: those files, with links to read them. POST {name, size, ...}: get ready to upload one."""

    throttle_scope = "files"

    def get(self, request, workspace_id):
        membership = services.membership_for(request.user, workspace_id)
        raw = request.query_params.get("ids", "")
        try:
            ids = [int(part) for part in raw.split(",") if part]
        except ValueError:
            ids = None
        return Response(files.data_for(files.listed(membership, ids)))

    def post(self, request, workspace_id):
        membership = services.membership_for(request.user, workspace_id)
        data = request.data
        file, targets = files.prepare(membership, request.user, data.get("name"), data.get("size"), data.get("width"), data.get("height"), data.get("thumb"))
        return _upload_response(file, targets, status.HTTP_201_CREATED)


class FileApi(APIView):
    """POST: fresh upload links, to try again. DELETE: give up on an upload that hasn't finished."""

    throttle_scope = "files"

    def post(self, request, workspace_id, file_id):
        membership = services.membership_for(request.user, workspace_id)
        return _upload_response(*files.restart(membership, request.user, file_id))

    def delete(self, request, workspace_id, file_id):
        files.cancel(services.membership_for(request.user, workspace_id), request.user, file_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class FileDoneApi(APIView):
    throttle_scope = "files"

    def post(self, request, workspace_id, file_id):
        file = files.finish(services.membership_for(request.user, workspace_id), request.user, file_id)
        return Response(files.data_for([file])[0])
