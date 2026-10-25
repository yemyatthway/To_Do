"""Production (Render). Everything secret or host-specific comes from environment variables;
see the "Deploying" section of the README for the full list."""

from .base import *  # noqa: F403
from .base import env

DEBUG = False

# Render tells the app its own hostname; add any custom domain with ALLOWED_HOSTS.
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])
if render_host := env("RENDER_EXTERNAL_HOSTNAME", default=""):
    ALLOWED_HOSTS.append(render_host)

# The app calls /api on its own (Vercel) domain, which forwards to Render, so the browser never
# makes cross-site requests and CORS stays off. These origins may use the cookie endpoints.
TRUSTED_FRONTEND_ORIGINS = env.list("TRUSTED_FRONTEND_ORIGINS")
CSRF_TRUSTED_ORIGINS = [f"https://{host}" for host in ALLOWED_HOSTS if host]  # Django admin login

# HTTPS everywhere. Render terminates TLS and says so in X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
# Render's health check calls the app directly over plain HTTP; don't redirect it.
SECURE_REDIRECT_EXEMPT = [r"^api/health/$"]
SECURE_HSTS_SECONDS = 60 * 60 * 24 * 30
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
REFRESH_COOKIE_SECURE = True
X_FRAME_OPTIONS = "DENY"

EMAIL_ALLOW_RESERVED_DOMAINS = False

# Warnings and errors (failed emails, failed pushes) show up in Render's log view.
LOGGING["root"] = {"handlers": ["console"], "level": "WARNING"}  # noqa: F405
