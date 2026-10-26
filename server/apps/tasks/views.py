from datetime import timedelta

from django.conf import settings
from django.db.models import Prefetch, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from .models import Task
from .serializers import TaskSerializer


def _parse_bound(request, name):
    raw = request.query_params.get(name)
    if raw is None:
        return None
    value = parse_datetime(raw)
    if value is None or value.tzinfo is None:
        raise ValidationError({name: "Use an ISO 8601 datetime with a timezone, e.g. 2026-10-25T00:00:00Z."})
    return value


OVERDUE_LIMIT = 100


class TaskViewSet(viewsets.ModelViewSet):
    """
    CRUD for tasks.

    List filters (the client sends its own local-day boundaries, so no server timezone guessing):
      ?start=<iso>&end=<iso>  tasks due in [start, end)
      ?anytime=1              also include tasks without a due time
      ?overdue_before=<iso>   only unfinished tasks due before then (the client's start of today),
                              newest first, at most OVERDUE_LIMIT

    DELETE moves a task to "Recently deleted" (soft delete). From there:
      GET  /trash/              deleted tasks you can still restore (newest first)
      POST /<id>/restore/       bring one back
      DELETE /<id>/purge/       erase one now;  DELETE /trash/ empties the whole list
    The daily clean-up erases them after TASK_RESTORE_DAYS.
    """

    serializer_class = TaskSerializer
    pagination_class = None

    def _changed(self):
        """Your other open devices (phone + laptop) update at once."""
        from apps.live import ably

        ably.to_users([self.request.user.pk], "tasks")

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)
        self._changed()

    def perform_update(self, serializer):
        from apps.social.linked import SYNCED_FIELDS, sync_copies

        before = {field: getattr(serializer.instance, field) for field in SYNCED_FIELDS}
        task = serializer.save()
        sync_copies(task, before)  # a shared plan: everyone else's copy changes too
        self._changed()

    def perform_destroy(self, task):
        from apps.social.linked import cancel_copies

        task.deleted_at = timezone.now()
        task.save(update_fields=["deleted_at"])
        cancel_copies(task)
        self._changed()

    def _trash(self):
        cutoff = timezone.now() - timedelta(days=settings.TASK_RESTORE_DAYS)
        return Task.all_objects.filter(owner=self.request.user, deleted_at__gte=cutoff)

    @action(detail=False, methods=["get", "delete"])
    def trash(self, request):
        if request.method == "DELETE":
            Task.all_objects.filter(owner=request.user, deleted_at__isnull=False).delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        tasks = self._trash().order_by("-deleted_at")
        return Response(self.get_serializer(tasks, many=True).data)

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        task = get_object_or_404(self._trash(), pk=pk)
        task.deleted_at = None
        task.save(update_fields=["deleted_at"])
        return Response(self.get_serializer(task).data)

    @action(detail=True, methods=["delete"])
    def purge(self, request, pk=None):
        get_object_or_404(Task.all_objects.filter(owner=request.user, deleted_at__isnull=False), pk=pk).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    def get_queryset(self):
        # Users only ever see their own tasks; other people's ids 404.
        queryset = Task.objects.filter(owner=self.request.user).select_related("added_by").prefetch_related(
            Prefetch("linked_copies", queryset=Task.objects.select_related("owner"))
        )
        if self.action != "list":
            return queryset

        overdue_before = _parse_bound(self.request, "overdue_before")
        if overdue_before is not None:
            return queryset.filter(done=False, due_at__lt=overdue_before).order_by("-due_at")[:OVERDUE_LIMIT]

        start = _parse_bound(self.request, "start")
        end = _parse_bound(self.request, "end")
        if start is None and end is None:
            return queryset

        in_range = Q(due_at__isnull=False)
        if start is not None:
            in_range &= Q(due_at__gte=start)
        if end is not None:
            in_range &= Q(due_at__lt=end)
        if self.request.query_params.get("anytime") in ("1", "true"):
            in_range |= Q(due_at__isnull=True)
        return queryset.filter(in_range)
