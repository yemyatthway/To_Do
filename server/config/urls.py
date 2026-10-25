from django.conf import settings
from django.contrib import admin
from django.urls import include, path

from apps.users.cron import PruneView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/", include("apps.users.auth_urls")),
    path("api/admin/", include("apps.users.admin_urls")),
    path("api/tasks/", include("apps.tasks.urls")),
    path("api/push/", include("apps.notifications.urls")),
    path("api/social/", include("apps.social.urls")),
    path("api/cron/prune/", PruneView.as_view()),
]

if settings.DEBUG:
    from apps.users.dev_views import email_preview

    urlpatterns.append(path("dev/emails/<str:name>/", email_preview))
