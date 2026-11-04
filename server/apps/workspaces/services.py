import json
import math
import re
import secrets
from datetime import timedelta
from datetime import timezone as dt_timezone

from django.conf import settings
from django.core import signing
from django.core.validators import validate_email
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, F, Q
from django.utils.dateparse import parse_datetime
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from apps.live import ably
from apps.users.language import tr
from apps.social.services import _notify
from apps.tasks.models import Task
from apps.users import mail, usernames
from apps.users.models import User

from . import files
from . import permissions as perms
from .models import ActivityEvent, Comment, Invitation, Membership, Notification, Page, Table, TableRow, Workspace

MAX_WORKSPACES = 20
MAX_MEMBERS = 50
INVITE_DAYS = 14
_GUEST_SIGNER = signing.Signer(salt="workspaces.guest", sep=".")
MAX_PAGES = 500
MAX_LIVE_BYTES = 48_000  # Ably's limit is 64 KB a message
MAX_BLOCKS = 2000
MAX_BLOCK_TEXT = 10_000
MAX_PAGE_CHARS = 200_000
BLOCK_TYPES = {"p", "h", "todo", "file"}
MAX_TABLES = 200
MAX_COLUMNS = 30
MAX_ROWS = 2000
MAX_CELL_TEXT = 5000
COLUMN_TYPES = {"text", "number", "select", "person", "date", "checkbox", "file"}
MAX_CELL_FILES = 10
MAX_COMMENT_FILES = 6
STARTER_COLUMNS = [("Description", "text"), ("Assigned", "person"), ("Done", "checkbox")]
MAX_COMMENT = 2000
MENTION = re.compile(r"(?<![\w.@])@([A-Za-z0-9._]{1,20})")
COALESCE_MINUTES = 10
PAGE_SIZE = 30


def _members(workspace):
    return (
        workspace.memberships.select_related("user")
        .filter(user__is_active=True, user__deleted_at__isnull=True)
    )


def _tell_members(workspace, *also):
    ids = list(workspace.memberships.values_list("user_id", flat=True)) + list(also)
    ably.to_users(ids, "workspaces")


def _tell_open(workspace_id, name, data):
    """For whoever has this workspace open. Sent once it's really saved, so a reload finds the same."""
    transaction.on_commit(lambda: ably.to_workspace(workspace_id, name, data))


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
    _log(workspace, me, "workspace.renamed", title=workspace.name)
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
    language = user.language if user is not None else me.language
    app_url = settings.APP_URL.rstrip("/")
    mail.send(
        to=email,
        subject=tr(language, "{who} invited you to {workspace} on Todo Clock", who=who, workspace=workspace.name),
        template="workspace_invite",
        context={
            "language": language, "who": who, "workspace": workspace.name, "role": tr(language, role.capitalize()), "days": INVITE_DAYS,
            "app_url": f"{app_url}/?view=workspaces",
            # No account yet: they can look around, read only, until they join.
            "guest_url": f"{app_url}/guest/{guest_token(invitation)}" if user is None else None,
            "preheader": tr(language, "Join {workspace} on Todo Clock.", workspace=workspace.name),
        },
    )
    if user is not None:
        _notify(user, tr(user, "Workspace invitation"), tr(user, "{who} invited you to {workspace}.", who=who, workspace=workspace.name), url="/?view=workspaces", event="workspaces")
    _tell_members(workspace)
    return invitation


def guest_token(invitation):
    return _GUEST_SIGNER.sign(str(invitation.pk))


def guest_invitation(token):
    """The invitation behind a guest link. It stops working the moment the invitation is cancelled,
    answered or out of date, so the owner stays in control of who can look."""
    try:
        invitation_id = int(_GUEST_SIGNER.unsign(token or ""))
    except (signing.BadSignature, ValueError):
        raise NotFound("This link doesn't work.")
    invitation = (
        Invitation.objects.select_related("workspace", "invited_by")
        .filter(pk=invitation_id, workspace__deleted_at__isnull=True)
        .first()
    )
    if invitation is not None and invitation.status == Invitation.Status.ACCEPTED:
        raise NotFound("You've already joined this workspace. Log in to open it.")
    if invitation is None or invitation.status != Invitation.Status.PENDING or invitation.expires_at <= timezone.now():
        raise NotFound("This link doesn't work any more. Ask whoever invited you for a new invitation.")
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
    _log(invitation.workspace, me, "member.joined")
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
    _log(membership.workspace, me, "member.role", title=_name(target.user), detail={"role": role})
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
        name = _name(target.user)
        target.delete()
    if user_id == me.pk:
        _log(membership.workspace, me, "member.left")
    else:
        _log(membership.workspace, me, "member.removed", title=name)
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


def _clean_title(title):
    title = " ".join(str(title or "").split())
    return title[:120] or "Untitled"


def _clean_blocks(blocks, workspace):
    """Only what the editor can show gets stored: this reaches every member's screen."""
    if not isinstance(blocks, list):
        raise ValidationError({"blocks": ["That page content isn't valid."]})
    if len(blocks) > MAX_BLOCKS:
        raise ValidationError({"blocks": [f"A page can have up to {MAX_BLOCKS} blocks."]})
    cleaned, seen, total = [], set(), 0
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") not in BLOCK_TYPES or not isinstance(block.get("text"), str):
            raise ValidationError({"blocks": ["That page content isn't valid."]})
        block_id = block.get("id")
        if not isinstance(block_id, str) or not 0 < len(block_id) <= 64 or block_id in seen:
            raise ValidationError({"blocks": ["That page content isn't valid."]})
        if len(block["text"]) > MAX_BLOCK_TEXT:
            raise ValidationError({"blocks": [f"Keep each block under {MAX_BLOCK_TEXT:,} characters."]})
        total += len(block["text"])
        if total > MAX_PAGE_CHARS:
            raise ValidationError({"blocks": ["This page is too long. Split it into two pages."]})
        seen.add(block_id)
        item = {"id": block_id, "type": block["type"], "text": block["text"]}
        if block["type"] == "todo":
            item["done"] = block.get("done") is True
        if block["type"] == "file":
            if type(block.get("file")) is not int:
                raise ValidationError({"blocks": ["That page content isn't valid."]})
            item["file"] = block["file"]
            item["text"] = ""
        cleaned.append(item)
    # A file that's gone (an upload that never finished) leaves the page. So does anyone else's.
    present = set(files.known(workspace, [item["file"] for item in cleaned if item["type"] == "file"]))
    return [item for item in cleaned if item["type"] != "file" or item["file"] in present]


def pages_of(me, workspace_id):
    membership = membership_for(me, workspace_id)
    return membership.workspace.pages.select_related("updated_by").order_by("-updated_at", "-id")


def page_for(me, workspace_id, page_id):
    membership = membership_for(me, workspace_id)
    page = membership.workspace.pages.select_related("updated_by").filter(pk=page_id).first()
    if page is None:
        raise NotFound("That page doesn't exist.")
    return page


def create_page(me, workspace_id, title):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.EDIT)
    workspace = membership.workspace
    if workspace.pages.count() >= MAX_PAGES:
        raise ValidationError({"title": [f"A workspace can have up to {MAX_PAGES} pages."]})
    page = Page.objects.create(workspace=workspace, title=_clean_title(title), created_by=me, updated_by=me)
    _log(workspace, me, "page.created", "page", page.pk, page.title)
    _tell_team(me, workspace, Notification.Kind.NEW_WORK, lambda user: tr(user, "{name} added a page to {workspace}", name=_name(me), workspace=workspace.name), page.title, _link(workspace.pk, page=page))
    _tell_members(workspace)
    return page


def _page_event(me, page):
    """The whole page when it fits in a live message; otherwise open apps fetch it."""
    data = {
        "id": page.pk, "version": page.version, "by": me.pk, "updated_by": _name(me), "updated_at": page.updated_at.isoformat(),
        "title": page.title, "blocks": page.blocks,
    }
    if len(json.dumps(data, ensure_ascii=False).encode()) > MAX_LIVE_BYTES:
        return {key: data[key] for key in ("id", "version", "by")}
    return data


class PageConflict(Exception):
    """Someone saved a newer version than the one this edit started from."""

    def __init__(self, current):
        self.current = current


def update_page(me, workspace_id, page_id, base_version, title=None, blocks=None):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.EDIT)
    if type(base_version) is not int:
        raise ValidationError({"base_version": ["Say which version this edit started from."]})
    cleaned = None if blocks is None else _clean_blocks(blocks, membership.workspace)
    with transaction.atomic():
        page = membership.workspace.pages.select_for_update().filter(pk=page_id).first()
        if page is None:
            raise NotFound("That page doesn't exist.")
        if page.version != base_version:
            raise PageConflict(page)
        renamed = title is not None and _clean_title(title) != page.title
        if title is not None:
            page.title = _clean_title(title)
        if cleaned is not None:
            page.blocks = cleaned
        page.version += 1
        page.updated_by = me
        page.save()
    _tell_open(workspace_id, "page", _page_event(me, page))
    # Saves come every second or so while typing, so only what changes other people's lists goes further.
    _log(membership.workspace, me, "page.edited", "page", page.pk, page.title, coalesce=True)
    if renamed:
        _tell_members(membership.workspace)
    return page


def delete_page(me, workspace_id, page_id):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.EDIT)
    page = membership.workspace.pages.filter(pk=page_id).first()
    if page is None:
        raise NotFound("That page doesn't exist.")
    page.deleted_at = timezone.now()
    page.save(update_fields=["deleted_at"])
    _log(membership.workspace, me, "page.deleted", "page", page.pk, page.title)
    _tell_members(membership.workspace)


def restore_page(me, workspace_id, page_id):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.EDIT)
    page = Page.all_objects.filter(workspace=membership.workspace, pk=page_id, deleted_at__isnull=False).first()
    if page is None:
        raise NotFound("That page can't be restored.")
    page.deleted_at = None
    page.save(update_fields=["deleted_at"])
    _log(membership.workspace, me, "page.restored", "page", page.pk, page.title)
    _tell_members(membership.workspace)
    return page


def _new_column(name, column_type):
    return {"id": f"c{secrets.token_hex(4)}", "name": name, "type": column_type}


def _clean_column_name(name):
    name = " ".join(str(name or "").split())
    if not name:
        raise ValidationError({"name": ["Give the column a name."]})
    if len(name) > 60:
        raise ValidationError({"name": ["Keep the name under 60 characters."]})
    return name


def _clean_description(description):
    description = " ".join(str(description or "").split())
    if len(description) > 500:
        raise ValidationError({"description": ["Keep the description under 500 characters."]})
    return description


def _cell_error(message):
    return ValidationError({"values": [message]})


def _clean_cell(column, value, workspace):
    """What a cell may hold depends on its column. Refuse anything else: this reaches everyone's screen."""
    kind = column["type"]
    if kind == "text":
        if value is None:
            return ""
        if not isinstance(value, str):
            raise _cell_error(f"{column['name']} must be text.")
        if len(value) > MAX_CELL_TEXT:
            raise _cell_error(f"Keep {column['name']} under {MAX_CELL_TEXT:,} characters.")
        return value
    if kind == "number":
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e15:
            raise _cell_error(f"{column['name']} must be a number.")
        return value
    if kind == "select":
        if value is None:
            return None
        if not isinstance(value, str):
            raise _cell_error(f"{column['name']} must be text.")
        value = " ".join(value.split())
        if len(value) > 60:
            raise _cell_error(f"Keep {column['name']} under 60 characters.")
        return value or None
    if kind == "person":
        if value is None:
            return None
        if type(value) is not int or not workspace.memberships.filter(user_id=value).exists():
            raise _cell_error("Choose someone in this workspace.")
        return value
    if kind == "date":
        if value is None or value == "":
            return None
        try:
            parsed = parse_datetime(value) if isinstance(value, str) else None
        except ValueError:  # the right shape but an impossible date, like month 13
            parsed = None
        if parsed is None or parsed.tzinfo is None:
            raise _cell_error(f"{column['name']} must be a date and time.")
        return parsed.astimezone(dt_timezone.utc).isoformat()
    if kind == "file":
        return files.clean_list(workspace, value, MAX_CELL_FILES, "values")
    if value is None:
        return False
    if not isinstance(value, bool):
        raise _cell_error(f"{column['name']} must be yes or no.")
    return value


def _clean_cells(table, values):
    if not isinstance(values, dict):
        raise _cell_error("That row isn't valid.")
    columns = {c["id"]: c for c in table.columns}
    cleaned = {}
    for column_id, value in values.items():
        if column_id not in columns:
            raise _cell_error("That column no longer exists. Refresh and try again.")
        cleaned[column_id] = _clean_cell(columns[column_id], value, table.workspace)
    return cleaned


def _table_for(me, workspace_id, table_id, action=perms.READ, lock=False):
    membership = membership_for(me, workspace_id)
    perms.require(membership, action)
    tables = membership.workspace.tables.select_related("workspace", "updated_by")
    if lock:
        tables = tables.select_for_update(of=("self",))
    table = tables.filter(pk=table_id).first()
    if table is None:
        raise NotFound("That table doesn't exist.")
    return table


def _tell_table(table):
    _tell_open(table.workspace_id, "table", {"id": table.pk, "version": table.version})


def _touch(table, me, announce=True):
    Table.objects.filter(pk=table.pk).update(version=F("version") + 1, updated_by=me, updated_at=timezone.now())
    table.refresh_from_db(fields=["version", "updated_by", "updated_at"])
    if announce:
        _tell_table(table)


def tables_of(me, workspace_id):
    membership = membership_for(me, workspace_id)
    return membership.workspace.tables.select_related("updated_by").order_by("-updated_at", "-id")


def table_for(me, workspace_id, table_id):
    return _table_for(me, workspace_id, table_id)


def rows_of(table):
    return list(table.rows.all())


def create_table(me, workspace_id, title):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.EDIT)
    workspace = membership.workspace
    if workspace.tables.count() >= MAX_TABLES:
        raise ValidationError({"title": [f"A workspace can have up to {MAX_TABLES} tables."]})
    table = Table.objects.create(
        workspace=workspace, title=_clean_title(title), columns=[_new_column(*c) for c in STARTER_COLUMNS], created_by=me, updated_by=me,
    )
    _log(workspace, me, "table.created", "table", table.pk, table.title)
    _tell_team(me, workspace, Notification.Kind.NEW_WORK, lambda user: tr(user, "{name} added a table to {workspace}", name=_name(me), workspace=workspace.name), table.title, f"/workspaces/{workspace.pk}/tables/{table.pk}")
    _tell_members(workspace)
    return table


def update_table(me, workspace_id, table_id, title=None, description=None):
    with transaction.atomic():
        table = _table_for(me, workspace_id, table_id, perms.EDIT, lock=True)
        renamed = title is not None and _clean_title(title) != table.title
        if title is not None:
            table.title = _clean_title(title)
        if description is not None:
            table.description = _clean_description(description)
        table.version += 1
        _tell_table(table)
        table.updated_by = me
        table.save()
    if renamed:
        _log(table.workspace, me, "table.renamed", "table", table.pk, table.title)
        _tell_members(table.workspace)
    return table


def delete_table(me, workspace_id, table_id):
    table = _table_for(me, workspace_id, table_id, perms.EDIT)
    table.deleted_at = timezone.now()
    table.save(update_fields=["deleted_at"])
    _log(table.workspace, me, "table.deleted", "table", table.pk, table.title)
    _tell_members(table.workspace)


def restore_table(me, workspace_id, table_id):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.EDIT)
    table = Table.all_objects.filter(workspace=membership.workspace, pk=table_id, deleted_at__isnull=False).first()
    if table is None:
        raise NotFound("That table can't be restored.")
    table.deleted_at = None
    table.save(update_fields=["deleted_at"])
    _log(membership.workspace, me, "table.restored", "table", table.pk, table.title)
    _tell_members(membership.workspace)
    return table


def add_column(me, workspace_id, table_id, name, column_type):
    if column_type not in COLUMN_TYPES:
        raise ValidationError({"type": ["Choose a column type."]})
    name = _clean_column_name(name)
    with transaction.atomic():
        table = _table_for(me, workspace_id, table_id, perms.EDIT, lock=True)
        if len(table.columns) >= MAX_COLUMNS:
            raise ValidationError({"name": [f"A table can have up to {MAX_COLUMNS} columns."]})
        table.columns = [*table.columns, _new_column(name, column_type)]
        table.version += 1
        _tell_table(table)
        table.updated_by = me
        table.save()
    _log(table.workspace, me, "column.added", "table", table.pk, table.title, {"column": name})
    return table


def _column_index(table, column_id):
    for index, column in enumerate(table.columns):
        if column["id"] == column_id:
            return index
    raise NotFound("That column doesn't exist.")


def update_column(me, workspace_id, table_id, column_id, name=None, position=None):
    with transaction.atomic():
        table = _table_for(me, workspace_id, table_id, perms.EDIT, lock=True)
        index = _column_index(table, column_id)
        columns = [dict(c) for c in table.columns]
        old_name = columns[index]["name"]
        if name is not None:
            columns[index]["name"] = _clean_column_name(name)
        if position is not None:
            if type(position) is not int:
                raise ValidationError({"position": ["That position isn't valid."]})
            column = columns.pop(index)
            columns.insert(max(0, min(position, len(columns))), column)
        table.columns = columns
        table.version += 1
        _tell_table(table)
        table.updated_by = me
        table.save()
    if name is not None and _clean_column_name(name) != old_name:
        _log(table.workspace, me, "column.renamed", "table", table.pk, table.title, {"column": _clean_column_name(name), "was": old_name})
    return table


def delete_column(me, workspace_id, table_id, column_id):
    with transaction.atomic():
        table = _table_for(me, workspace_id, table_id, perms.EDIT, lock=True)
        removed = table.columns[_column_index(table, column_id)]["name"]
        table.columns = [c for c in table.columns if c["id"] != column_id]
        table.version += 1
        _tell_table(table)
        table.updated_by = me
        table.save()
    _log(table.workspace, me, "column.removed", "table", table.pk, table.title, {"column": removed})
    return table


def _refuse_assigning_yourself(me, table, cells, before):
    """Owners and admins hand work out, so they can't assign it to themselves. A row that already
    names them stays as it is until someone changes it."""
    people = {column["id"] for column in table.columns if column["type"] == "person"}
    if not any(column in people and value == me.pk and before.get(column) != me.pk for column, value in cells.items()):
        return
    role = table.workspace.memberships.filter(user=me).values_list("role", flat=True).first()
    if role in (perms.OWNER, perms.ADMIN):
        raise ValidationError({"values": ["Owners and admins can't assign work to themselves."]})


def create_row(me, workspace_id, table_id, values=None):
    with transaction.atomic():
        table = _table_for(me, workspace_id, table_id, perms.EDIT, lock=True)
        if table.rows.count() >= MAX_ROWS:
            raise ValidationError({"values": [f"A table can have up to {MAX_ROWS:,} rows. Start a new table."]})
        cells = _clean_cells(table, values or {})
        _refuse_assigning_yourself(me, table, cells, {})
        row = TableRow.objects.create(table=table, no=table.next_no, values=cells, created_by=me, updated_by=me)
        table.next_no += 1
        table.version += 1
        _tell_table(table)
        table.updated_by = me
        table.save()
    _log(table.workspace, me, "row.created", "row", row.pk, table.title, _row_detail(row))
    _tell_assigned(me, table, row, {}, row.values)
    _announce_row(me, table, row, {})
    _tell_members(table.workspace)
    return row


class RowConflict(Exception):
    """A cell changed since this edit's copy of it."""

    def __init__(self, current):
        self.current = current


def _row_for(me, workspace_id, table_id, row_id, action, lock=False):
    table = _table_for(me, workspace_id, table_id, action)
    rows = table.rows.select_related("updated_by")
    if lock:
        rows = rows.select_for_update(of=("self",))
    row = rows.filter(pk=row_id).first()
    if row is None:
        raise NotFound("That row doesn't exist.")
    return table, row


def update_row(me, workspace_id, table_id, row_id, values=None, base=None, highlighted=None):
    if highlighted is not None and not isinstance(highlighted, bool):
        raise ValidationError({"highlighted": ["That isn't valid."]})
    with transaction.atomic():
        table, row = _row_for(me, workspace_id, table_id, row_id, perms.EDIT, lock=True)
        cleaned = _clean_cells(table, values or {})
        _refuse_assigning_yourself(me, table, cleaned, row.values)
        # `base` is what the app last saw. Someone changed one of those cells since: ask, don't overwrite.
        if isinstance(base, dict):
            for column_id in cleaned:
                if column_id in base and row.values.get(column_id) != base[column_id]:
                    if row.values.get(column_id) != cleaned[column_id]:
                        raise RowConflict(row)
        before = row.values
        row.values = {**row.values, **cleaned}
        if highlighted is not None:
            row.highlighted = highlighted
        row.updated_by = me
        row.save()
        _touch(table, me, announce=False)
        # One cell's new words go straight to open tables, with no need for them to fetch anything.
        _tell_open(table.workspace_id, "row", {"table": table.pk, "version": table.version, "row": row.pk, "values": cleaned, "highlighted": row.highlighted, "by": me.pk})
    names = [c["name"] for c in table.columns if c["id"] in cleaned and before.get(c["id"]) != cleaned[c["id"]]]
    if names:
        _log(table.workspace, me, "row.edited", "row", row.pk, table.title, {**_row_detail(row), "columns": names}, coalesce=True)
    _tell_assigned(me, table, row, before, cleaned)
    _announce_row(me, table, row, before)
    return row


def delete_row(me, workspace_id, table_id, row_id):
    table, row = _row_for(me, workspace_id, table_id, row_id, perms.EDIT)
    row.deleted_at = timezone.now()
    row.save(update_fields=["deleted_at"])
    _touch(table, me)
    _log(table.workspace, me, "row.deleted", "row", row.pk, table.title, _row_detail(row))
    _tell_members(table.workspace)


def restore_row(me, workspace_id, table_id, row_id):
    table = _table_for(me, workspace_id, table_id, perms.EDIT)
    row = TableRow.all_objects.filter(table=table, pk=row_id, deleted_at__isnull=False).first()
    if row is None:
        raise NotFound("That row can't be restored.")
    row.deleted_at = None
    row.save(update_fields=["deleted_at"])
    _touch(table, me)
    _log(table.workspace, me, "row.restored", "row", row.pk, table.title, _row_detail(row))
    _tell_members(table.workspace)
    return row


def my_tasks_from(me, table):
    """Which rows of this table are already on my task list."""
    return set(Task.objects.filter(owner=me, source_row__table=table).values_list("source_row_id", flat=True))


def add_row_to_tasks(me, workspace_id, table_id, row_id):
    """Anyone who can read the table can put a row on their own list. Pressed twice, it stays one task."""
    with transaction.atomic():
        table, row = _row_for(me, workspace_id, table_id, row_id, perms.READ, lock=True)
        existing = Task.objects.filter(owner=me, source_row=row).first()
        if existing:
            return row, existing
        text = next((row.values.get(c["id"]) for c in table.columns if c["type"] == "text" and row.values.get(c["id"], "").strip()), None)
        title = " ".join(text.split())[:200] if text else f"{table.title} {row.no}"[:200]
        dates = [row.values.get(c["id"]) for c in table.columns if c["type"] == "date" and row.values.get(c["id"])]
        due_at = next((parsed for parsed in (parse_datetime(d) for d in dates) if parsed and parsed > timezone.now()), None)
        task = Task.objects.create(
            owner=me, title=title, notes=f"From {table.title} in {table.workspace.name}, row {row.no}", due_at=due_at,
            category=Task.Category.WORK, remind_before_minutes=10 if due_at else None, source_row=row,
        )
    ably.to_users([me.pk], "tasks")
    return row, task


def _name(user):
    if user is None:
        return "Someone"
    return user.full_name or f"@{user.username}"


def _row_detail(row):
    return {"no": row.no, "table_id": row.table_id}


def _log(workspace, actor, verb, kind="", target_id=None, title="", detail=None, coalesce=False):
    """Add a line to the workspace's history. Saves come every second or so while someone types, so
    with `coalesce` a repeat of the same thing soon after updates the last line instead of adding one."""
    now = timezone.now()
    detail = detail or {}
    _tell_open(workspace.pk, "activity", {})
    if coalesce:
        recent = (
            ActivityEvent.objects.filter(
                workspace=workspace, actor=actor, verb=verb, target_kind=kind, target_id=target_id,
                created_at__gte=now - timedelta(minutes=COALESCE_MINUTES),
            )
            .order_by("-created_at", "-id")
            .first()
        )
        if recent:
            if "columns" in detail:
                detail = {**detail, "columns": list(dict.fromkeys([*recent.detail.get("columns", []), *detail["columns"]]))}
            recent.title, recent.detail, recent.created_at = title[:200], detail, now
            recent.save(update_fields=["title", "detail", "created_at"])
            return recent
    return ActivityEvent.objects.create(
        workspace=workspace, actor=actor, verb=verb, target_kind=kind, target_id=target_id, title=title[:200], detail=detail, created_at=now,
    )


def activity_of(me, workspace_id, before=None, page_id=None, row_id=None):
    membership = membership_for(me, workspace_id)
    events = membership.workspace.activity.select_related("actor")
    if page_id is not None:
        events = events.filter(target_kind="page", target_id=page_id)
    if row_id is not None:
        events = events.filter(target_kind="row", target_id=row_id)
    if before is not None:
        events = events.filter(pk__lt=before)
    # Newest ids first, so "show more" can simply ask for anything older than the last one shown.
    return list(events.order_by("-id")[: PAGE_SIZE + 1])


ACTIVITY_KINDS = {
    "pages": ("page.",),
    "tables": ("table.", "column."),
    "rows": ("row.",),
    "comments": ("comment.",),
    "people": ("member.", "workspace."),
}
ACTIVITY_PAGE_SIZE = 20


def activity_page(me, workspace_id, number, query="", actor=None, kind="", since=None):
    """The Activity screen: returns (events on that page, the page it really is, how many pages)."""
    events = membership_for(me, workspace_id).workspace.activity.select_related("actor")
    if query := query.strip()[:100]:
        events = events.filter(Q(title__icontains=query) | Q(actor__full_name__icontains=query) | Q(actor__username__icontains=query))
    if actor is not None:
        events = events.filter(actor_id=actor)
    if kind in ACTIVITY_KINDS:
        rule = Q()
        for prefix in ACTIVITY_KINDS[kind]:
            rule |= Q(verb__startswith=prefix)
        events = events.filter(rule)
    if since is not None:
        events = events.filter(created_at__gte=since)
    pages = max(math.ceil(events.count() / ACTIVITY_PAGE_SIZE), 1)
    number = min(max(number, 1), pages)
    return list(events.order_by("-created_at", "-id")[(number - 1) * ACTIVITY_PAGE_SIZE : number * ACTIVITY_PAGE_SIZE]), number, pages


def _link(workspace_id, page=None, row=None):
    if page is not None:
        return f"/workspaces/{workspace_id}/pages/{page.pk}"
    return f"/workspaces/{workspace_id}/tables/{row.table_id}/rows/{row.pk}"


def _inform(recipient, actor, workspace, kind, title, body, url):
    Notification.objects.create(recipient=recipient, actor=actor, workspace=workspace, kind=kind, title=title[:240], body=body[:280], url=url)
    _notify(recipient, title, body, url=url, event="notifications")


def _tell_team(me, workspace, kind, title_for, body, url):
    """Everyone else in the workspace, each in their own language: in the app and as a push now,
    by email shortly (digest.py)."""
    for membership in workspace.memberships.select_related("user").exclude(user=me):
        _inform(membership.user, me, workspace, kind, title_for(membership.user), body, url)


def _row_name(user, table, row):
    return tr(user, "row {no} of {table}", no=row.no, table=table.title)


def _row_text(table, values):
    return next((" ".join(values[c["id"]].split()) for c in table.columns if c["type"] == "text" and (values.get(c["id"]) or "").strip()), "")


def _announce_row(me, table, row, before):
    """New work counts from the moment a row says something, since New makes an empty one first.
    Finished means its first checkbox, like the table's progress bar, was just ticked."""
    text = _row_text(table, row.values)
    workspace = table.workspace
    url = _link(workspace.pk, row=row)
    if text and not _row_text(table, before):
        _tell_team(me, workspace, Notification.Kind.NEW_WORK, lambda user: tr(user, "{name} added work to {table}", name=_name(me), table=table.title), text, url)
    done = next((c for c in table.columns if c["type"] == "checkbox"), None)
    if done and row.values.get(done["id"]) is True and before.get(done["id"]) is not True:
        _tell_team(me, workspace, Notification.Kind.DONE, lambda user: tr(user, "{name} finished {what}", name=_name(me), what=text or _row_name(user, table, row)), table.title, url)


def _assigned_people(table, values):
    return {values.get(c["id"]) for c in table.columns if c["type"] == "person"} - {None}


def _tell_assigned(me, table, row, before, changed):
    """A row was just given to someone: let them know. Not when you assign yourself."""
    for column in table.columns:
        if column["type"] != "person" or column["id"] not in changed:
            continue
        person_id = changed[column["id"]]
        if person_id is None or person_id == me.pk or before.get(column["id"]) == person_id:
            continue
        membership = table.workspace.memberships.select_related("user").filter(user_id=person_id).first()
        if membership:
            text = next((row.values.get(c["id"]) for c in table.columns if c["type"] == "text" and row.values.get(c["id"])), "")
            _inform(membership.user, me, table.workspace, Notification.Kind.ASSIGNED, tr(membership.user, "{name} assigned you {what}", name=_name(me), what=_row_name(membership.user, table, row)), " ".join(text.split()), _link(table.workspace_id, row=row))


def _comment_target(membership, page_id=None, table_id=None, row_id=None):
    workspace = membership.workspace
    if page_id is not None:
        page = workspace.pages.filter(pk=page_id).first()
        if page is None:
            raise NotFound("That page doesn't exist.")
        return page, None, None
    table = workspace.tables.filter(pk=table_id).first()
    row = table.rows.filter(pk=row_id).first() if table else None
    if row is None:
        raise NotFound("That row doesn't exist.")
    return None, table, row


def comments_of(me, workspace_id, page_id=None, table_id=None, row_id=None):
    membership = membership_for(me, workspace_id)
    page, _table, row = _comment_target(membership, page_id, table_id, row_id)
    comments = page.comments if page else row.comments
    return list(comments.select_related("author"))


def mentioned_in(workspace, body):
    """The workspace members a comment @mentions. Anyone else's name in there is just text."""
    names = {name.lower() for name in MENTION.findall(body)}
    if not names:
        return []
    return [m.user for m in workspace.memberships.select_related("user").filter(user__username__in=names, user__is_active=True, user__deleted_at__isnull=True)]


def add_comment(me, workspace_id, body, page_id=None, table_id=None, row_id=None, file_ids=None):
    membership = membership_for(me, workspace_id)
    perms.require(membership, perms.COMMENT, "Your role in this workspace doesn't allow commenting.")
    workspace = membership.workspace
    attached = files.clean_list(workspace, file_ids, MAX_COMMENT_FILES, "files")
    body = str(body or "").strip()
    if not body and not attached:
        raise ValidationError({"body": ["Write something first."]})
    if len(body) > MAX_COMMENT:
        raise ValidationError({"body": [f"Keep comments under {MAX_COMMENT:,} characters."]})
    page, table, row = _comment_target(membership, page_id, table_id, row_id)
    earlier = page.comments if page else row.comments
    earlier_authors = set(earlier.exclude(author=None).values_list("author_id", flat=True))
    comment = Comment.objects.create(workspace=workspace, page=page, row=row, author=me, body=body, files=attached)
    summary = body or "Shared a file"
    if page:
        _log(workspace, me, "comment.page", "page", page.pk, page.title)
        where = lambda user: page.title
        url = _link(workspace.pk, page=page)
    else:
        _log(workspace, me, "comment.row", "row", row.pk, table.title, _row_detail(row))
        _touch(table, me)
        where = lambda user: _row_name(user, table, row)
        url = _link(workspace.pk, row=row)
    # Everyone gets one notification at most, and the most personal one.
    mentioned = [user for user in mentioned_in(workspace, body) if user.pk != me.pk]
    for user in mentioned:
        _inform(user, me, workspace, Notification.Kind.MENTION, tr(user, "{name} mentioned you on {where}", name=_name(me), where=where(user)), summary, url)
    followers = set(earlier_authors) | (_assigned_people(table, row.values) if row else set())
    followers -= {me.pk, *(u.pk for u in mentioned)}
    for other in workspace.memberships.select_related("user").filter(user_id__in=followers):
        _inform(other.user, me, workspace, Notification.Kind.COMMENT, tr(other.user, "{name} commented on {where}", name=_name(me), where=where(other.user)), summary, url)
    _tell_members(workspace)
    return comment


def delete_comment(me, workspace_id, comment_id):
    membership = membership_for(me, workspace_id)
    comment = membership.workspace.comments.select_related("row__table").filter(pk=comment_id).first()
    if comment is None:
        raise NotFound("That comment doesn't exist.")
    if comment.author_id != me.pk:
        perms.require(membership, perms.MANAGE_MEMBERS, "Only the owner and admins can delete other people's comments.")
    comment.deleted_at = timezone.now()
    comment.save(update_fields=["deleted_at"])
    if comment.row:
        _touch(comment.row.table, me)
    _tell_members(membership.workspace)


def comment_counts(table):
    counts = Comment.objects.filter(row__table=table).values("row_id").annotate(count=Count("id"))
    return {item["row_id"]: item["count"] for item in counts}


def notifications_of(me, before=None):
    items = Notification.objects.filter(recipient=me, workspace__deleted_at__isnull=True).select_related("actor")
    unread = items.filter(read_at__isnull=True).count()
    if before is not None:
        items = items.filter(pk__lt=before)
    return list(items.order_by("-id")[: PAGE_SIZE + 1]), unread


def mark_read(me, ids=None, workspace_id=None):
    items = Notification.objects.filter(recipient=me, read_at__isnull=True)
    if workspace_id is not None:
        if type(workspace_id) is not int:
            raise ValidationError({"workspace": ["That workspace isn't valid."]})
        items = items.filter(workspace_id=workspace_id)
    if ids is not None:
        if not isinstance(ids, list) or not all(type(i) is int for i in ids):
            raise ValidationError({"ids": ["That list isn't valid."]})
        items = items.filter(pk__in=ids)
    items.update(read_at=timezone.now())
