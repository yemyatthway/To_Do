"""Who can do what in a workspace. The one place these rules live: every later feature (pages,
tables, comments) asks `can()` here, and the app's buttons only reflect the answer."""

from rest_framework.exceptions import PermissionDenied

OWNER, ADMIN, EDITOR, COMMENTER, VIEWER = "owner", "admin", "editor", "commenter", "viewer"
ROLE_ORDER = [VIEWER, COMMENTER, EDITOR, ADMIN, OWNER]

READ, COMMENT, EDIT, MANAGE_MEMBERS, RENAME, DELETE_WORKSPACE, TRANSFER = (
    "read", "comment", "edit", "manage_members", "rename", "delete_workspace", "transfer",
)

ALLOWED = {
    READ: {OWNER, ADMIN, EDITOR, COMMENTER, VIEWER},
    COMMENT: {OWNER, ADMIN, EDITOR, COMMENTER},
    EDIT: {OWNER, ADMIN, EDITOR},
    MANAGE_MEMBERS: {OWNER, ADMIN},
    RENAME: {OWNER, ADMIN},
    DELETE_WORKSPACE: {OWNER},
    TRANSFER: {OWNER},
}

# What each role may be set to by invite or role change. Ownership only moves by transfer.
ASSIGNABLE = [ADMIN, EDITOR, COMMENTER, VIEWER]


def can(role, action):
    return role in ALLOWED[action]


def require(membership, action, message="Your role in this workspace doesn't allow that."):
    if not can(membership.role, action):
        raise PermissionDenied(message)


def abilities(role):
    """For the app, so it can hide what would be refused."""
    return {action: can(role, action) for action in ALLOWED}
