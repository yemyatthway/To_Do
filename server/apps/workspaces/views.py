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
