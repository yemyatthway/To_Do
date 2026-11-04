"""Development only (DEBUG): see the email templates in a browser at /dev/emails/<name>/."""

from django.http import Http404, HttpResponse

from . import mail
from .models import User

SAMPLES = {
    "verify": lambda: ("code", mail.code_context("verify", "482913")),
    "login": lambda: ("code", mail.code_context("login", "482913", "Safari on macOS")),
    "welcome": lambda: ("welcome", mail.welcome_context(User(full_name="Mia Thompson"))),
    "workspace_invite": lambda: ("workspace_invite", {"subject": "Mia invited you to Dev Team on Todo Clock", "who": "Mia Thompson", "workspace": "Dev Team", "role": "Editor", "days": 14, "app_url": "http://localhost:5173/?view=workspaces", "preheader": "Join Dev Team on Todo Clock."}),
}


SAMPLES["workspace_update"] = lambda: ("workspace_update", {
    "subject": "3 updates in Dev Team", "eyebrow": "Dev Team", "heading": "3 updates in your workspace",
    "items": [{"title": "Aung Kyaw finished Login button overlaps", "body": "Bug list"}, {"title": "Mia Thet added work to Bug list", "body": "Chat list jumps after sending"}, {"title": "Sara Win added a page to Dev Team", "body": "Release notes"}],
    "more": 0, "open_url": "http://localhost:5173/notifications", "open_label": "See what changed", "preheader": "Aung Kyaw finished Login button overlaps",
})


def email_preview(request, name):
    if name not in SAMPLES:
        raise Http404("Try verify, login or welcome.")
    template, context = SAMPLES[name]()
    text, html = mail.render(template, {"subject": "Preview", **context})
    if request.GET.get("format") == "text":
        return HttpResponse(text, content_type="text/plain; charset=utf-8")
    return HttpResponse(html)
