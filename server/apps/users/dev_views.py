"""Development only (DEBUG): see the email templates in a browser at /dev/emails/<name>/."""

from django.http import Http404, HttpResponse

from . import mail
from .models import User

SAMPLES = {
    "verify": lambda: ("code", mail.code_context("verify", "482913")),
    "login": lambda: ("code", mail.code_context("login", "482913", "Safari on macOS")),
    "welcome": lambda: ("welcome", mail.welcome_context(User(full_name="Mia Thompson"))),
}


def email_preview(request, name):
    if name not in SAMPLES:
        raise Http404("Try verify, login or welcome.")
    template, context = SAMPLES[name]()
    text, html = mail.render(template, {"subject": "Preview", **context})
    if request.GET.get("format") == "text":
        return HttpResponse(text, content_type="text/plain; charset=utf-8")
    return HttpResponse(html)
