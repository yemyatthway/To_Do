"""Admin-only endpoints (is_staff): user counts, account details, auth event log, ban/unban."""

from datetime import timedelta

from django.db.models import Count, F, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import AuthEvent, User
from .services import ban_user, restore_deadline, unban_user


class AdminUserSerializer(serializers.ModelSerializer):
    task_count = serializers.IntegerField(read_only=True)
    status = serializers.SerializerMethodField()
    # Deleted accounts: when the daily clean-up erases them for good.
    erase_after = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "full_name",
            "status",
            "email_verified",
            "is_active",
            "is_staff",
            "timezone",
            "reminders_enabled",
            "task_count",
            "date_joined",
            "last_login_at",
            "last_login_ip",
            "banned_at",
            "ban_reason",
            "deleted_at",
            "erase_after",
        ]

    def get_erase_after(self, user):
        return restore_deadline(user) if user.deleted_at else None

    def get_status(self, user):
        if user.deleted_at:
            return "deleted"
        if user.banned_at:
            return "banned"
        return "active" if user.is_active else "inactive"


class AuthEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = AuthEvent
        fields = ["id", "user", "email", "kind", "ip_address", "created_at"]


class BanSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")


class AdminPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


def _users():
    # all_objects: admins see recently deleted accounts too (status "deleted"); counts skip deleted tasks.
    return User.all_objects.annotate(task_count=Count("tasks", filter=Q(tasks__deleted_at__isnull=True))).order_by("-date_joined")


def _ordering(request, fields, default):
    """?ordering=<key> or -<key>, limited to `fields` ({key: model field}). Empty values (never
    logged in) always sort last, whichever way you sort; ties fall back to id so pages don't shuffle."""
    raw = request.query_params.get("ordering") or default
    descending = raw.startswith("-")
    field = fields.get(raw.lstrip("-"))
    if field is None:
        raise ValidationError({"ordering": [f"Sort by one of: {', '.join(fields)}."]})
    expression = F(field).desc(nulls_last=True) if descending else F(field).asc(nulls_last=True)
    return [expression, "-id" if descending else "id"]


def _paged(request, view, queryset, serializer):
    paginator = AdminPagination()
    page = paginator.paginate_queryset(queryset, request, view=view)
    return paginator.get_paginated_response(serializer(page, many=True).data)


USER_ORDERING = {"name": "full_name", "email": "email", "joined": "date_joined", "last_login": "last_login_at", "tasks": "task_count"}
EVENT_ORDERING = {"time": "created_at", "email": "email", "kind": "kind"}
SINCE = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}


class AdminStatsApi(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        now = timezone.now()
        users = User.objects.all()
        return Response(
            {
                "total_users": users.count(),
                "active_users": users.filter(is_active=True).count(),
                "banned_users": users.filter(banned_at__isnull=False).count(),
                "deleted_users": User.all_objects.filter(deleted_at__isnull=False).count(),
                "new_users_7d": users.filter(date_joined__gte=now - timedelta(days=7)).count(),
                "logins_24h": AuthEvent.objects.filter(kind=AuthEvent.Kind.LOGIN, created_at__gte=now - timedelta(days=1)).count(),
            }
        )


class AdminUserListApi(APIView):
    """?search=<email or name>&status=active|banned|inactive|deleted&verified=yes|no
    &ordering=name|email|joined|last_login|tasks (prefix - for descending)&page=N&page_size=N"""

    permission_classes = [IsAdminUser]

    def get(self, request):
        params = request.query_params
        queryset = _users()
        if search := params.get("search", "").strip():
            queryset = queryset.filter(Q(email__icontains=search) | Q(full_name__icontains=search))
        status_filter = params.get("status")
        if status_filter == "banned":
            queryset = queryset.filter(banned_at__isnull=False, deleted_at__isnull=True)
        elif status_filter == "active":
            queryset = queryset.filter(is_active=True)
        elif status_filter == "inactive":
            queryset = queryset.filter(is_active=False, banned_at__isnull=True, deleted_at__isnull=True)
        elif status_filter == "deleted":
            queryset = queryset.filter(deleted_at__isnull=False)
        if params.get("verified") in ("yes", "no"):
            queryset = queryset.filter(email_verified_at__isnull=params["verified"] == "no")
        queryset = queryset.order_by(*_ordering(request, USER_ORDERING, "-joined"))
        return _paged(request, self, queryset, AdminUserSerializer)


class AdminUserDetailApi(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, user_id):
        user = get_object_or_404(_users(), pk=user_id)
        data = AdminUserSerializer(user).data
        data["recent_events"] = AuthEventSerializer(user.auth_events.all()[:50], many=True).data
        return Response(data)


class AdminBanApi(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request, user_id):
        user = get_object_or_404(User, pk=user_id)
        serializer = BanSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ban_user(user=user, by=request.user, reason=serializer.validated_data["reason"])
        return Response(AdminUserSerializer(get_object_or_404(_users(), pk=user_id)).data)


class AdminUnbanApi(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request, user_id):
        unban_user(user=get_object_or_404(User, pk=user_id))
        return Response(AdminUserSerializer(get_object_or_404(_users(), pk=user_id)).data)


class AdminAuthEventListApi(APIView):
    """The activity log. ?search=<email or IP>&kind=signup|login|logout|deleted|restored&since=24h|7d|30d&user=<id>
    &ordering=time|email|kind (prefix - for descending)&page=N&page_size=N"""

    permission_classes = [IsAdminUser]

    def get(self, request):
        params = request.query_params
        queryset = AuthEvent.objects.all()
        if user_id := params.get("user"):
            queryset = queryset.filter(user_id=user_id)
        if search := params.get("search", "").strip():
            queryset = queryset.filter(Q(email__icontains=search) | Q(ip_address__startswith=search))
        if kind := params.get("kind"):
            if kind not in AuthEvent.Kind.values:
                raise ValidationError({"kind": [f"Use one of: {', '.join(AuthEvent.Kind.values)}."]})
            queryset = queryset.filter(kind=kind)
        if since := SINCE.get(params.get("since", "")):
            queryset = queryset.filter(created_at__gte=timezone.now() - since)
        queryset = queryset.order_by(*_ordering(request, EVENT_ORDERING, "-time"))
        return _paged(request, self, queryset, AuthEventSerializer)
