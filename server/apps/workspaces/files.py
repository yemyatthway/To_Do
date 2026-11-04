"""Screenshots and files in a workspace. Pages, table cells and comments just hold a file's id:
what's stored, who may read it and when it's cleaned up are decided here."""

import re
import uuid
from datetime import timedelta
from pathlib import PurePosixPath

import requests
from django.conf import settings
from django.db.models import Sum
from django.utils import timezone
from rest_framework.exceptions import APIException, NotFound, PermissionDenied, ValidationError

from . import permissions as perms
from . import storage
from .models import Comment, Page, TableRow, WorkspaceFile

MAX_LISTED = 100
MAX_THUMB_BYTES = 2 * 1024 * 1024
READ_LINK_SECONDS = 60 * 60
UNFINISHED_KEEP_HOURS = 24
UNUSED_KEEP_DAYS = 30  # long enough for restoring a deleted block, page or row to bring its files back
IMAGES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}
ALLOWED = {
    **IMAGES,
    "heic": "image/heic",
    "pdf": "application/pdf",
    "txt": "text/plain",
    "log": "text/plain",
    "md": "text/markdown",
    "csv": "text/csv",
    "json": "application/json",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
}
THUMBS = {"webp": "image/webp", "jpeg": "image/jpeg"}


class StorageUnavailable(APIException):
    status_code = 503
    default_detail = "Files can't be reached right now. Try again in a moment."


def _mb(size):
    return f"{size / (1024 * 1024):.0f} MB"


def _looks_like_image(head):
    return head.startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF8")) or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")


def _clean_name(name):
    name = PurePosixPath(str(name or "").replace("\\", "/")).name
    name = " ".join(re.sub(r"[\x00-\x1f\x7f]", "", name).split())
    if len(name) > 150:
        stem, dot, extension = name.rpartition(".")
        name = f"{stem[: 149 - len(extension)]}{dot}{extension}"
    return name


def _extension(name):
    return name.rpartition(".")[2].lower() if "." in name else ""


def _dimension(value):
    return value if type(value) is int and 0 < value <= 30000 else None


def _used(**filters):
    return WorkspaceFile.objects.filter(**filters).aggregate(total=Sum("size"))["total"] or 0


def _targets(file):
    """Every link the browser needs to finish this upload."""
    try:
        upload = storage.upload_target(file.key, file.content_type)
        thumb = storage.upload_target(file.thumb_key, THUMBS["webp" if file.thumb_key.endswith("webp") else "jpeg"]) if file.thumb_key else None
    except (requests.RequestException, KeyError, ValueError) as error:
        raise StorageUnavailable from error
    return {"upload": upload, "thumb_upload": thumb}


def prepare(membership, me, name, size, width=None, height=None, thumb=None):
    """Checks the file is welcome and returns its record and where to send it."""
    perms.require(membership, perms.COMMENT, "Your role in this workspace doesn't allow adding files.")
    if not storage.enabled():
        raise StorageUnavailable("Adding files isn't set up on this server yet.")
    name = _clean_name(name)
    extension = _extension(name)
    if not name or extension not in ALLOWED:
        raise ValidationError({"name": ["That type of file can't be added. Images, PDFs, documents, spreadsheets, text, videos and zip files are fine."]})
    if type(size) is not int or size <= 0:
        raise ValidationError({"size": ["That file looks empty."]})
    if size > settings.FILE_MAX_BYTES:
        raise ValidationError({"size": [f"That file is too big. The limit is {_mb(settings.FILE_MAX_BYTES)}."]})
    if _used(uploaded_by=me) + size > settings.FILE_USER_QUOTA:
        raise ValidationError({"size": [f"You've used your {_mb(settings.FILE_USER_QUOTA)} of file space. Files nobody uses any more are cleared after {UNUSED_KEEP_DAYS} days."]})
    if _used() + size > settings.FILE_TOTAL_QUOTA:
        raise ValidationError({"size": ["The app's file space is full right now, so this one can't be added."]})
    stem = f"w{membership.workspace_id}/{uuid.uuid4().hex}"
    file = WorkspaceFile.objects.create(
        workspace=membership.workspace,
        uploaded_by=me,
        name=name,
        size=size,
        content_type=ALLOWED[extension],
        key=f"{stem}.{extension}",
        thumb_key=f"{stem}-thumb.{thumb}" if thumb in THUMBS else "",
        width=_dimension(width),
        height=_dimension(height),
    )
    try:
        return file, _targets(file)
    except StorageUnavailable:
        file.delete()
        raise


def _mine_unfinished(membership, me, file_id):
    file = membership.workspace.files.filter(pk=file_id).first()
    if file is None:
        raise NotFound("That file doesn't exist.")
    if file.uploaded_by_id != me.pk:
        raise PermissionDenied("Only the person adding this file can do that.")
    return file


def restart(membership, me, file_id):
    """Fresh links, for trying again after the first ones ran out."""
    file = _mine_unfinished(membership, me, file_id)
    if file.status == WorkspaceFile.Status.READY:
        raise ValidationError({"file": ["That file is already uploaded."]})
    return file, _targets(file)


def finish(membership, me, file_id):
    """The browser says it's done. Believe the stored file, not the browser."""
    file = _mine_unfinished(membership, me, file_id)
    if file.status == WorkspaceFile.Status.READY:
        return file
    try:
        found = storage.peek(file.key)
        thumb = storage.peek(file.thumb_key) if file.thumb_key else None
    except (requests.RequestException, OSError, ValueError) as error:
        raise StorageUnavailable from error
    if found is None:
        raise ValidationError({"file": ["The upload didn't arrive. Try again."]})
    size, head = found
    declared_image = _extension(file.key) in IMAGES
    if size > settings.FILE_MAX_BYTES or size <= 0 or (declared_image and not _looks_like_image(head)):
        file.delete()  # the stored copy goes with it
        message = "That doesn't look like an image." if declared_image and size > 0 else "That file can't be added."
        raise ValidationError({"file": [message]})
    if file.thumb_key and (thumb is None or thumb[0] > MAX_THUMB_BYTES or not _looks_like_image(thumb[1])):
        storage.remove_quietly([file.thumb_key])
        file.thumb_key = ""
    file.size = size
    file.status = WorkspaceFile.Status.READY
    file.is_image = declared_image
    file.save(update_fields=["size", "status", "is_image", "thumb_key"])
    return file


def cancel(membership, me, file_id):
    file = _mine_unfinished(membership, me, file_id)
    if file.status == WorkspaceFile.Status.READY:
        raise ValidationError({"file": ["That file is already uploaded."]})
    file.delete()


def listed(membership, ids):
    if not isinstance(ids, list) or len(ids) > MAX_LISTED or any(type(i) is not int for i in ids):
        raise ValidationError({"ids": ["Those files aren't valid."]})
    return list(membership.workspace.files.select_related("uploaded_by").filter(pk__in=ids))


def data_for(files):
    """What the app needs to show each file, with links that work for an hour."""
    ready = [file for file in files if file.status == WorkspaceFile.Status.READY]
    keys = [key for file in ready for key in (file.key, file.thumb_key) if key]
    try:
        links = storage.sign(keys, READ_LINK_SECONDS) if storage.enabled() else {}
    except (requests.RequestException, KeyError, ValueError) as error:
        raise StorageUnavailable from error
    expires = timezone.now() + timedelta(seconds=READ_LINK_SECONDS)
    return [_file_data(file, links, expires) for file in files]


def _file_data(file, links, expires):
    url = links.get(file.key)
    joiner = "&" if url and "?" in url else "?"
    uploader = file.uploaded_by
    return {
        "id": file.pk,
        "name": file.name,
        "size": file.size,
        "status": file.status,
        "is_image": file.is_image,
        "width": file.width,
        "height": file.height,
        "uploaded_by": uploader.pk if uploader else None,
        "url": url,
        "thumb_url": links.get(file.thumb_key) or url,
        "download_url": f"{url}{joiner}download={requests.utils.quote(file.name, safe='')}" if url else None,
        "expires_at": expires,
    }


def known(workspace, ids):
    """The ids that really are files in this workspace, in their order."""
    if not ids:
        return []
    found = set(workspace.files.filter(pk__in=ids).values_list("pk", flat=True))
    return [i for i in ids if i in found]


def clean_list(workspace, value, limit, field):
    """A list of file ids from the app. One that's gone (a failed upload was cleared) simply drops out."""
    if value is None:
        return []
    if not isinstance(value, list) or any(type(i) is not int for i in value):
        raise ValidationError({field: ["Those files aren't valid."]})
    value = list(dict.fromkeys(value))
    if len(value) > limit:
        raise ValidationError({field: [f"Add up to {limit} files here."]})
    return known(workspace, value)


def in_use(workspace):
    """Every file id something still points at, counting deleted things that can still be restored."""
    used = set()
    for blocks in Page.all_objects.filter(workspace=workspace).values_list("blocks", flat=True):
        used.update(block["file"] for block in blocks if block.get("type") == "file")
    for row in TableRow.all_objects.filter(table__workspace=workspace).select_related("table"):
        for column in row.table.columns:
            if column["type"] == "file":
                used.update(row.values.get(column["id"]) or [])
    for files in Comment.all_objects.filter(workspace=workspace).exclude(files=[]).values_list("files", flat=True):
        used.update(files)
    return used


def shown_to_guest(workspace, ids):
    """Of these, the files a guest can see: only those on a page or in a table, never one in a
    comment or in the bin."""
    shown = set()
    for blocks in workspace.pages.values_list("blocks", flat=True):
        shown.update(block.get("file") for block in blocks if block.get("type") == "file")
    for table in workspace.tables.all():
        columns = [column["id"] for column in table.columns if column["type"] == "file"]
        if columns:
            for values in table.rows.values_list("values", flat=True):
                for column in columns:
                    shown.update(values.get(column) or [])
    wanted = [i for i in ids if i in shown]
    return list(workspace.files.select_related("uploaded_by").filter(pk__in=wanted))


def prune(now=None):
    """Clears uploads that never finished, then files nothing has pointed at for a while."""
    now = now or timezone.now()
    unfinished = WorkspaceFile.objects.filter(status=WorkspaceFile.Status.PENDING, created_at__lt=now - timedelta(hours=UNFINISHED_KEEP_HOURS))
    removed = 0
    for file in unfinished:
        file.delete()
        removed += 1
    old = WorkspaceFile.objects.filter(status=WorkspaceFile.Status.READY, created_at__lt=now - timedelta(days=UNUSED_KEEP_DAYS)).select_related("workspace")
    by_workspace = {}
    for file in old:
        by_workspace.setdefault(file.workspace, []).append(file)
    for workspace, files in by_workspace.items():
        used = in_use(workspace)
        for file in files:
            if file.pk not in used:
                file.delete()
                removed += 1
    return removed
