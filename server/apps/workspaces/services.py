from datetime import timedelta

from django.conf import settings
from django.core.validators import validate_email
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from apps.live import ably
from apps.social.services import _notify
from apps.users import mail, usernames
from apps.users.models import User

from . import permissions as perms
from .models import Invitation, Membership, Workspace

MAX_WORKSPACES = 20
MAX_MEMBERS = 50
INVITE_DAYS = 14


def _members(workspace):
    return (
        workspace.memberships.select_related("user")
        .filter(user__is_active=True, user__deleted_at__isnull=True)
    )


def _tell_members(workspace, *also):
    ids = list(workspace.memberships.values_list("user_id", flat=True)) + list(also)
    ably.to_users(ids, "workspaces")


def membership_for(me, workspace_id, lock=False):
    """Your membership, or 404: someone outside can't tell whether a workspace exists."""
    memberships = Membership.objects.select_related("workspace", "user")
    if lock:
        memberships = memberships.select_for_update(of=("self",))
    membership = memberships.filter(user=me, workspace_id=workspace_id, workspace__deleted_at__isnull=True).first()
    if membership is None:
        raise NotFound("That workspace doesn't exist.")
    return membership


def _clean_name(name):
    name = " ".join(str(name or "").split())  # also keeps line breaks out of email subjects
    if not name:
        raise ValidationError({"name": ["Give the workspace a name."]})
    if len(name) > 80:
        raise ValidationError({"name": ["Keep the name under 80 characters."]})
    return name


def _assignable(role):
    if role not in perms.ASSIGNABLE:
        raise ValidationError({"role": ["Choose Admin, Editor, Commenter or Viewer."]})
    return role


def create(me, name):
    name = _clean_name(name)
    if Membership.objects.filter(user=me, role=perms.OWNER, workspace__deleted_at__isnull=True).count() >= MAX_WORKSPACES:
        raise ValidationError({"name": [f"You can own up to {MAX_WORKSPACES} workspaces."]})
    with transaction.atomic():
        workspace = Workspace.objects.create(name=name)
        Membership.objects.create(workspace=workspace, user=me, role=perms.OWNER)
    ably.to_users([me.pk], "workspaces")
    return workspace


def rename(me, workspace_id, name):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.RENAME)
    workspace = membership.workspace
    workspace.name = _clean_name(name)
    workspace.save(update_fields=["name"])
    _tell_members(workspace)
    return workspace


def delete(me, workspace_id, confirm_name):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.DELETE_WORKSPACE, "Only the owner can delete a workspace.")
    workspace = membership.workspace
    if (confirm_name or "").strip() != workspace.name:
        raise ValidationError({"confirm_name": ["Type the workspace's name exactly to confirm."]})
    workspace.deleted_at = timezone.now()
    workspace.save(update_fields=["deleted_at"])
    workspace.invitations.filter(status=Invitation.Status.PENDING).update(status=Invitation.Status.CANCELLED)
    _tell_members(workspace)


def _resolve_invitee(invitee):
    """(email, label, user or None). Inviting an address gives the same answer whether or not it
    has an account, so this can't be used to find out who has signed up."""
    typed = (invitee or "").strip()
    if not typed:
        raise ValidationError({"invitee": ["Enter a @username or an email address."]})
    if "@" in typed[1:]:
        email = typed.lower()
        try:
            validate_email(email)
        except DjangoValidationError:
            raise ValidationError({"invitee": ["That email address doesn't look right."]})
        return email, email, User.objects.filter(email__iexact=email, is_active=True).first()
    handle = usernames.normalize(typed)
    user = User.objects.filter(username=handle, is_active=True).first()
    if user is None:
        raise ValidationError({"invitee": [f"No one has the username @{handle}."]})
    return user.email, f"@{handle}", user


def invite(me, workspace_id, invitee, role):
    role = _assignable(role)
    email, label, user = _resolve_invitee(invitee)
    if user is not None and user.pk == me.pk:
        raise ValidationError({"invitee": ["You're already in this workspace."]})
    with transaction.atomic():
        membership = membership_for(me, workspace_id, lock=True)
        perms.require(membership, perms.MANAGE_MEMBERS, "Only the owner and admins can invite people.")
        workspace = membership.workspace
        if role == perms.ADMIN and membership.role != perms.OWNER:
            raise PermissionDenied("Only the owner can invite someone as an admin.")
        if user is not None and workspace.memberships.filter(user=user).exists():
            raise ValidationError({"invitee": ["They're already in this workspace."]})
        if _members(workspace).count() + workspace.invitations.filter(status=Invitation.Status.PENDING).count() >= MAX_MEMBERS:
            raise ValidationError({"invitee": [f"A workspace can have up to {MAX_MEMBERS} people."]})
        try:
            with transaction.atomic():
                invitation = Invitation.objects.create(
                    workspace=workspace, email=email, label=label, role=role, invited_by=me,
                    expires_at=timezone.now() + timedelta(days=INVITE_DAYS),
                )
        except IntegrityError:
            raise ValidationError({"invitee": ["They already have an invitation waiting."]})
    who = " ".join(me.full_name.split()) or f"@{me.username}"
    mail.send(
        to=email,
        subject=f"{who} invited you to {workspace.name} on To-Do",
        template="workspace_invite",
        context={
            "who": who, "workspace": workspace.name, "role": role.capitalize(), "days": INVITE_DAYS,
            "app_url": f"{settings.APP_URL.rstrip('/')}/?view=workspaces",
            "preheader": f"Join {workspace.name} on To-Do.",
        },
    )
    if user is not None:
        _notify(user, "Workspace invitation", f"{who} invited you to {workspace.name}.", url="/?view=workspaces", event="workspaces")
    _tell_members(workspace)
    return invitation


def cancel_invitation(me, workspace_id, invitation_id):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.MANAGE_MEMBERS)
    updated = membership.workspace.invitations.filter(pk=invitation_id, status=Invitation.Status.PENDING).update(status=Invitation.Status.CANCELLED)
    if not updated:
        raise NotFound("That invitation doesn't exist.")
    _tell_members(membership.workspace)


def my_invitations(me):
    """Waiting invitations for this verified address (the default permission requires one)."""
    return (
        Invitation.objects.filter(email__iexact=me.email, status=Invitation.Status.PENDING, expires_at__gt=timezone.now(), workspace__deleted_at__isnull=True)
        .select_related("workspace", "invited_by")
        .order_by("-created_at")
    )


def _my_invitation(me, invitation_id):
    invitation = my_invitations(me).filter(pk=invitation_id).first()
    if invitation is None:
        raise NotFound("That invitation is no longer available.")
    return invitation


def accept(me, invitation_id):
    with transaction.atomic():
        invitation = _my_invitation(me, invitation_id)
        Invitation.objects.select_for_update().get(pk=invitation.pk)
        membership, _ = Membership.objects.get_or_create(workspace=invitation.workspace, user=me, defaults={"role": invitation.role})
        Invitation.objects.filter(pk=invitation.pk).update(status=Invitation.Status.ACCEPTED)
    _tell_members(invitation.workspace)
    return membership


def decline(me, invitation_id):
    invitation = _my_invitation(me, invitation_id)
    Invitation.objects.filter(pk=invitation.pk).update(status=Invitation.Status.DECLINED)
    _tell_members(invitation.workspace, me.pk)


def _target(workspace, user_id):
    target = workspace.memberships.select_for_update().filter(user_id=user_id).first()
    if target is None:
        raise NotFound("They aren't in this workspace.")
    return target


def set_role(me, workspace_id, user_id, role):
    role = _assignable(role)
    with transaction.atomic():
        membership = membership_for(me, workspace_id, lock=True)
        perms.require(membership, perms.MANAGE_MEMBERS, "Only the owner and admins can change roles.")
        target = _target(membership.workspace, user_id)
        if target.role == perms.OWNER:
            raise PermissionDenied("The owner's role only changes by transferring ownership.")
        if membership.role != perms.OWNER and (target.role == perms.ADMIN or role == perms.ADMIN):
            raise PermissionDenied("Only the owner can add or change admins.")
        target.role = role
        target.save(update_fields=["role"])
    _tell_members(membership.workspace)
    return target


def remove_member(me, workspace_id, user_id):
    """Remove someone, or yourself (leaving). Owners transfer or delete instead."""
    with transaction.atomic():
        membership = membership_for(me, workspace_id, lock=True)
        target = _target(membership.workspace, user_id)
        if target.role == perms.OWNER:
            raise PermissionDenied("The owner can't leave. Transfer ownership or delete the workspace first.")
        if target.user_id != me.pk:
            perms.require(membership, perms.MANAGE_MEMBERS, "Only the owner and admins can remove people.")
            if membership.role != perms.OWNER and target.role == perms.ADMIN:
                raise PermissionDenied("Only the owner can remove an admin.")
        target.delete()
    _tell_members(membership.workspace, user_id)


def transfer(me, workspace_id, user_id):
    with transaction.atomic():
        membership = membership_for(me, workspace_id, lock=True)
        perms.require(membership, perms.TRANSFER, "Only the owner can transfer ownership.")
        target = _target(membership.workspace, user_id)
        if target.user_id == me.pk:
            raise ValidationError({"user_id": ["You already own this workspace."]})
        if not (target.user.is_active and target.user.deleted_at is None):
            raise ValidationError({"user_id": ["That person's account isn't active."]})
        # Step down first: the database allows only one owner at a time.
        membership.role = perms.ADMIN
        membership.save(update_fields=["role"])
        target.role = perms.OWNER
        target.save(update_fields=["role"])
    _tell_members(membership.workspace)


def members_of(workspace):
    return _members(workspace).order_by("joined_at")


def pending_invitations(workspace):
    return workspace.invitations.filter(status=Invitation.Status.PENDING, expires_at__gt=timezone.now()).order_by("-created_at")
