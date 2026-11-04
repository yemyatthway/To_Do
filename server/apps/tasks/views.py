from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Case, Count, F, IntegerField, Prefetch, Q, Value, When
from django.db.models.functions import Coalesce
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
BROWSE_PAGE_SIZE = 20
MAX_SEARCH = 100


def _same(field, a, b):
    if field == "due_at" and a and b:
        return parse_datetime(str(a)) == parse_datetime(str(b))
    return a == b


class TaskViewSet(viewsets.ModelViewSet):
    """
    CRUD for tasks.

    List filters (the client sends its own local-day boundaries, so no server timezone guessing):
      ?start=<iso>&end=<iso>  tasks due in [start, end)
      ?anytime=1              also include tasks without a due time
      ?overdue_before=<iso>   only unfinished tasks due before then (the client's start of today),
                              newest first, at most OVERDUE_LIMIT

    GET /browse/ is the Tasks page: one of the three lists (todo, overdue, done), a page at a time.

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

    def _existing(self, client_id):
        # Includes deleted tasks: a late resend must not bring one back as a new task.
        return Task.all_objects.filter(owner=self.request.user, client_id=client_id).first() if client_id else None

    def create(self, request, *args, **kwargs):
        """Sending the same client_id again returns the task already saved (200), so a retry is safe."""
        field = TaskSerializer().fields["client_id"]
        try:
            client_id = field.to_internal_value(request.data["client_id"]) if request.data.get("client_id") else None
        except ValidationError:
            client_id = None  # the serializer reports it
        if existing := self._existing(client_id):
            return Response(self.get_serializer(existing).data)
        try:
            with transaction.atomic():
                return super().create(request, *args, **kwargs)
        except IntegrityError:  # the same create arrived twice at once
            if existing := self._existing(client_id):
                return Response(self.get_serializer(existing).data)
            raise

    def partial_update(self, request, *args, **kwargs):
        """`base` is what the app last saw for the fields it's changing. If someone changed one of
        them since (another device, a friend's shared plan), answer 409 instead of overwriting."""
        task = self.get_object()
        base = request.data.get("base")
        if isinstance(base, dict):
            current = self.get_serializer(task).data
            for field, seen in base.items():
                if field not in current or field not in request.data:
                    continue
                if not _same(field, current[field], seen) and not _same(field, current[field], request.data[field]):
                    return Response(
                        {"detail": "This task was changed somewhere else.", "task": current},
                        status=status.HTTP_409_CONFLICT,
                    )
        return super().partial_update(request, *args, **kwargs)

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)
        transaction.on_commit(self._changed)

    def perform_update(self, serializer):
        from apps.social.linked import SYNCED_FIELDS, sync_copies

        before = {field: getattr(serializer.instance, field) for field in SYNCED_FIELDS}
        # Your task and your friends' copies change together, or not at all.
        with transaction.atomic():
            task = serializer.save()
            sync_copies(task, before)  # a shared plan: everyone else's copy changes too
        self._changed()

    def perform_destroy(self, task):
        from apps.social.linked import cancel_copies

        with transaction.atomic():
            task.deleted_at = timezone.now()
            task.save(update_fields=["deleted_at"])
            cancel_copies(task)
        self._changed()

    @action(detail=False)
    def browse(self, request):
        """?list=todo|overdue|done&now=<iso>&page=1, plus q, category, priority, from and to.
        The counts are for all three lists under the same search and filters."""
        params = request.query_params
        now = _parse_bound(request, "now") or timezone.now()
        lists = {
            "todo": Q(done=False) & (Q(due_at__gte=now) | Q(due_at__isnull=True)),
            "overdue": Q(done=False, due_at__lt=now),
            "done": Q(done=True),
        }
        chosen = params.get("list", "todo")
        if chosen not in lists:
            raise ValidationError({"list": "Use one of: todo, overdue, done."})
        try:
            page = max(int(params.get("page", 1)), 1)
        except ValueError:
            raise ValidationError({"page": "That isn't valid."})

        tasks = self.get_queryset()
        if query := params.get("q", "").strip()[:MAX_SEARCH]:
            tasks = tasks.filter(Q(title__icontains=query) | Q(notes__icontains=query))
        if params.get("category"):
            tasks = tasks.filter(category=params["category"])
        if params.get("priority"):
            tasks = tasks.filter(priority=params["priority"])
        if (after := _parse_bound(request, "from")) is not None:
            tasks = tasks.filter(due_at__gte=after)
        if (before := _parse_bound(request, "to")) is not None:
            tasks = tasks.filter(due_at__lt=before)

        counts = tasks.aggregate(**{name: Count("pk", filter=rule) for name, rule in lists.items()})
        rank = Case(When(priority="high", then=Value(0)), When(priority="medium", then=Value(1)), default=Value(2), output_field=IntegerField())
        order = {
            # Soonest first, and tasks with no time after every dated one.
            "todo": [F("due_at").asc(nulls_last=True), rank, "pk"],
            "overdue": [F("due_at").desc(), rank, "pk"],
            "done": [Coalesce("due_at", "completed_at", "updated_at").desc(), "-pk"],
        }[chosen]
        pages = max((counts[chosen] + BROWSE_PAGE_SIZE - 1) // BROWSE_PAGE_SIZE, 1)
        page = min(page, pages)
        rows = tasks.filter(lists[chosen]).order_by(*order)[(page - 1) * BROWSE_PAGE_SIZE : page * BROWSE_PAGE_SIZE]
        return Response({"results": self.get_serializer(rows, many=True).data, "counts": counts, "page": page, "pages": pages})

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
