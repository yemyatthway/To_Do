"""Stands in for Supabase on a developer's computer, so uploads behave the same way: the browser
sends the file to a short-lived link. Refused unless FILE_STORAGE is "local"."""

import mimetypes
from urllib.parse import quote

from django.conf import settings
from django.core import signing
from django.http import FileResponse, Http404, HttpResponse, HttpResponseNotAllowed
from django.views.decorators.csrf import csrf_exempt

from . import storage

UPLOAD_LINK_SECONDS = 2 * 60 * 60
READ_LINK_SECONDS = 60 * 60


def _put(request, token):
    try:
        path = storage.read_dev_token(token, "put", UPLOAD_LINK_SECONDS)
    except signing.BadSignature as error:
        raise Http404 from error
    data = request.read(settings.FILE_MAX_BYTES + 1)
    if len(data) > settings.FILE_MAX_BYTES:
        return HttpResponse(status=413)
    if path.exists():
        return HttpResponse(status=409)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return HttpResponse(status=200)


def _get(request, token):
    try:
        path = storage.read_dev_token(token, "get", READ_LINK_SECONDS)
    except signing.BadSignature as error:
        raise Http404 from error
    if not path.is_file():
        raise Http404
    response = FileResponse(path.open("rb"), content_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream")
    if "download" in request.GET:
        response["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(request.GET['download'])}"
    response["X-Content-Type-Options"] = "nosniff"
    return response


@csrf_exempt
def dev_file(request, token):
    if settings.FILE_STORAGE != "local":
        raise Http404
    if request.method == "PUT":
        return _put(request, token)
    if request.method == "GET":
        return _get(request, token)
    return HttpResponseNotAllowed(["GET", "PUT"])
