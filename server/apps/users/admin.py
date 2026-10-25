from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import AuthEvent, User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    ordering = ["email"]
    list_display = ["email", "full_name", "timezone", "reminders_enabled", "is_active", "date_joined"]
    search_fields = ["email", "full_name"]
    list_filter = ["is_active", "is_staff", "reminders_enabled"]
    readonly_fields = ["last_login_at", "last_login_ip", "password_changed_at", "banned_at"]
    fieldsets = [
        (None, {"fields": ["email", "password"]}),
        ("Profile", {"fields": ["full_name", "timezone", "reminders_enabled", "tutorial_seen"]}),
        ("Security", {"fields": ["failed_login_count", "locked_until", "last_login_at", "last_login_ip", "password_changed_at"]}),
        ("Status", {"fields": ["banned_at", "ban_reason"]}),
        ("Permissions", {"fields": ["is_active", "is_staff", "is_superuser", "groups", "user_permissions"]}),
    ]
    add_fieldsets = [(None, {"classes": ["wide"], "fields": ["email", "full_name", "password1", "password2"]})]


@admin.register(AuthEvent)
class AuthEventAdmin(admin.ModelAdmin):
    list_display = ["created_at", "email", "kind", "ip_address"]
    list_filter = ["kind"]
    search_fields = ["email", "ip_address"]
    readonly_fields = ["user", "email", "kind", "ip_address", "created_at"]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
