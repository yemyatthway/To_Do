from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.social.services import mask_email

from . import permissions as perms
from . import services
from .models import Membership


def member_data(membership):
    user = membership.user
    return {
        "id": user.pk, "full_name": user.full_name, "username": user.username, "email": mask_email(user.email),
        "role": membership.role, "joined_at": membership.joined_at,
    }


def summary_data(membership, member_count=None):
    workspace = membership.workspace
    return {
        "id": workspace.pk, "name": workspace.name, "role": membership.role, "created_at": workspace.created_at,
        "member_count": member_count if member_count is not None else services.members_of(workspace).count(),
    }


def detail_data(membership):
    workspace = membership.workspace
    data = summary_data(membership)
    data["can"] = perms.abilities(membership.role)
    data["assignable_roles"] = perms.ASSIGNABLE
    data["members"] = [member_data(m) for m in services.members_of(workspace)]
    # Only people who can manage members see who's been invited.
    data["invitations"] = (
        [{"id": i.pk, "label": i.label, "role": i.role, "created_at": i.created_at, "expires_at": i.expires_at} for i in services.pending_invitations(workspace)]
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
        return Response({
            "workspaces": [summary_data(m) for m in memberships],
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


def row_data(row, columns, on_my_tasks=False):
    known = {c["id"] for c in columns}
    return {
        "id": row.pk, "no": row.no, "values": {k: v for k, v in row.values.items() if k in known},
        "highlighted": row.highlighted, "on_my_tasks": on_my_tasks,
    }


def table_data(table, me):
    mine = services.my_tasks_from(me, table)
    return {
        **table_summary(table), "description": table.description, "columns": table.columns,
        "rows": [row_data(r, table.columns, r.pk in mine) for r in services.rows_of(table)],
    }


class TablesApi(APIView):
    """GET: the workspace's tables, newest first (no rows). POST {title}: create one."""

    def get(self, request, workspace_id):
        return Response([table_summary(t) for t in services.tables_of(request.user, workspace_id)])

    def post(self, request, workspace_id):
        table = services.create_table(request.user, workspace_id, request.data.get("title"))
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
        return Response(row_data(row, row.table.columns), status=status.HTTP_201_CREATED)


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
                {"detail": "Someone else changed this row.", "current": row_data(current, current.table.columns, current.pk in services.my_tasks_from(request.user, current.table))},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(row_data(row, row.table.columns, row.pk in services.my_tasks_from(request.user, row.table)))

    def delete(self, request, workspace_id, table_id, row_id):
        services.delete_row(request.user, workspace_id, table_id, row_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RestoreRowApi(APIView):
    def post(self, request, workspace_id, table_id, row_id):
        row = services.restore_row(request.user, workspace_id, table_id, row_id)
        return Response(row_data(row, row.table.columns, row.pk in services.my_tasks_from(request.user, row.table)))


class AddRowToTasksApi(APIView):
    def post(self, request, workspace_id, table_id, row_id):
        row, task = services.add_row_to_tasks(request.user, workspace_id, table_id, row_id)
        return Response({"row": row_data(row, row.table.columns, True), "task_title": task.title, "due_at": task.due_at})
