from django.urls import path

from .admin_apis import (
    AdminAuthEventListApi,
    AdminBanApi,
    AdminEmailLogApi,
    AdminStatsApi,
    AdminUnbanApi,
    AdminUserDetailApi,
    AdminUserListApi,
)

app_name = "admin-api"

urlpatterns = [
    path("stats/", AdminStatsApi.as_view(), name="stats"),
    path("emails/", AdminEmailLogApi.as_view(), name="emails"),
    path("users/", AdminUserListApi.as_view(), name="users"),
    path("users/<int:user_id>/", AdminUserDetailApi.as_view(), name="user-detail"),
    path("users/<int:user_id>/ban/", AdminBanApi.as_view(), name="user-ban"),
    path("users/<int:user_id>/unban/", AdminUnbanApi.as_view(), name="user-unban"),
    path("auth-events/", AdminAuthEventListApi.as_view(), name="auth-events"),
]
