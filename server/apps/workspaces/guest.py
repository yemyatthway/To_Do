"""Looking at a workspace from the link in an invitation, before having an account. Only these
GET views are open to a guest, and they answer with what's needed to read pages and tables:
no comments, activity or members' addresses, and nothing here can change anything."""

from rest_framework.exceptions import NotFound
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.social.services import mask_email

from . import files, services
from .views import page_data, page_summary, row_data, table_summary

MAX_FILES = files.MAX_LISTED


class GuestView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_scope = "guest"
    http_method_names = ["get", "head", "options"]

    @staticmethod
    def invitation(request):
        # In a header, so the link stays out of server logs.
        return services.guest_invitation(request.headers.get("X-Guest-Token"))

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response


class GuestWorkspaceApi(GuestView):
    def get(self, request):
        invitation = self.invitation(request)
        workspace = invitation.workspace
        inviter = invitation.invited_by
        return Response({
            "id": workspace.pk,
            "invitation": invitation.pk,
            "name": workspace.name,
            "role": invitation.role,
            "email": mask_email(invitation.email),
            "invited_by": (inviter.full_name or f"@{inviter.username}") if inviter else None,
            "expires_at": invitation.expires_at,
            "pages": [page_summary(p) for p in workspace.pages.select_related("updated_by").order_by("-updated_at", "-id")],
            "tables": [table_summary(t) for t in workspace.tables.select_related("updated_by").order_by("-updated_at", "-id")],
        })


class GuestPageApi(GuestView):
    def get(self, request, page_id):
        page = self.invitation(request).workspace.pages.select_related("updated_by").filter(pk=page_id).first()
        if page is None:
            raise NotFound("That page doesn't exist.")
        return Response(page_data(page))


def _people_in(workspace, columns, rows):
    """Only the people this table names, so a guest doesn't get the whole team."""
    person_columns = [column["id"] for column in columns if column["type"] == "person"]
    ids = {row.values.get(column) for row in rows for column in person_columns} - {None}
    return [
        {"id": m.user_id, "full_name": m.user.full_name or f"@{m.user.username}", "username": "", "email": "", "role": "viewer", "joined_at": None}
        for m in services.members_of(workspace).filter(user_id__in=ids)
    ]


class GuestTableApi(GuestView):
    def get(self, request, table_id):
        workspace = self.invitation(request).workspace
        table = workspace.tables.select_related("updated_by").filter(pk=table_id).first()
        if table is None:
            raise NotFound("That table doesn't exist.")
        rows = services.rows_of(table)
        return Response({
            **table_summary(table),
            "description": table.description,
            "columns": table.columns,
            "rows": [row_data(row, table.columns) for row in rows],
            "members": _people_in(workspace, table.columns, rows),
        })


class GuestFilesApi(GuestView):
    def get(self, request):
        workspace = self.invitation(request).workspace
        try:
            ids = [int(part) for part in request.query_params.get("ids", "").split(",") if part][:MAX_FILES]
        except ValueError:
            ids = []
        return Response(files.data_for(files.shown_to_guest(workspace, ids)))
