from django.contrib import admin

from .models import Task


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = ("title", "due_at", "category", "priority", "done")
    list_filter = ("done", "category", "priority")
    search_fields = ("title", "notes")
