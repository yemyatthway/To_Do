from datetime import timedelta
from pathlib import Path
import environ

env = environ.Env()

BASE_DIR = Path(__file__).resolve().parent.parent.parent

environ.Env.read_env(BASE_DIR / ".env")


SECRET_KEY = env("SECRET_KEY")

DEBUG = env.bool("DEBUG", default=False)

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])


INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",

    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",

    "apps.users",
    "apps.tasks",
    "apps.notifications",
    "apps.social",
]

AUTH_USER_MODEL = "users.User"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": (
        "apps.users.permissions.IsVerified",
    ),
    "DEFAULT_THROTTLE_CLASSES": (
        "rest_framework.throttling.ScopedRateThrottle",
    ),
    "DEFAULT_THROTTLE_RATES": {
        "login": "10/min",
        "register": "5/hour",
        "user_search": "60/min",
        "otp": "20/hour",
        "email_check": "60/min",
    },
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=30),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": False,
    "AUTH_HEADER_TYPES": ("Bearer",),
}

# Refresh token cookie (httpOnly, scoped to the auth endpoints).
REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_PATH = "/api/auth/"
REFRESH_COOKIE_SECURE = env.bool("REFRESH_COOKIE_SECURE", default=not DEBUG)
# "Lax" works when the frontend proxies /api on its own domain; "None" if it calls another domain directly.
REFRESH_COOKIE_SAMESITE = env("REFRESH_COOKIE_SAMESITE", default="Lax")

# Frontend origins allowed to call the cookie endpoints (login, refresh, logout).
TRUSTED_FRONTEND_ORIGINS = env.list("TRUSTED_FRONTEND_ORIGINS", default=[])

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # Serves the Django admin's CSS/JS in production (there's no separate static server).
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"


# Hosted databases give one DATABASE_URL (postgresql://user:pass@host:port/db); locally the DB_* parts.
if env("DATABASE_URL", default=""):
    DATABASES = {"default": env.db("DATABASE_URL")}
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": env("DB_NAME"),
            "USER": env("DB_USER"),
            "PASSWORD": env("DB_PASSWORD", default=""),
            "HOST": env("DB_HOST"),
            "PORT": env("DB_PORT"),
        }
    }
# Reuse connections between requests (saves a round trip to the database each time).
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=60)
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True


# Web Push (VAPID). Generate keys with: uv run python scripts/generate_vapid_keys.py
VAPID_PUBLIC_KEY = env("VAPID_PUBLIC_KEY")
VAPID_PRIVATE_KEY = env("VAPID_PRIVATE_KEY")
VAPID_SUBJECT = env("VAPID_SUBJECT")

# Shared secret for the scheduler that calls /api/push/send-due/. Empty disables the endpoint.
CRON_SECRET = env("CRON_SECRET", default="")


# Email (verification and sign-in codes). Gmail: smtp.gmail.com:587 with STARTTLS and an
# App Password (Google Account → Security → 2-Step Verification → App passwords).
# Without credentials, emails are written to .dev-emails/ instead so development still works.
EMAIL_HOST = env("EMAIL_HOST", default="smtp.gmail.com")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
# Google shows App Passwords as "abcd efgh ijkl mnop"; the spaces aren't part of it.
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="").replace(" ", "")
EMAIL_TIMEOUT = 15
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default=f"To-Do <{EMAIL_HOST_USER}>" if EMAIL_HOST_USER else "To-Do <no-reply@localhost>")
if EMAIL_HOST_USER and EMAIL_HOST_PASSWORD:
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
else:
    EMAIL_BACKEND = "django.core.mail.backends.filebased.EmailBackend"
    EMAIL_FILE_PATH = BASE_DIR / ".dev-emails"
# Send in a background thread so login/sign-up answer immediately (tests turn this off).
EMAIL_SEND_ASYNC = env.bool("EMAIL_SEND_ASYNC", default=True)
# Friend/share notifications go out in a background thread (tests switch this off).
PUSH_SEND_ASYNC = env.bool("PUSH_SEND_ASYNC", default=True)
# The app's address, for the "Open To-Do" button in the welcome email.
APP_URL = env("APP_URL", default="http://localhost:5173")

# One-time codes.
OTP_TTL_MINUTES = 10
OTP_MAX_ATTEMPTS = 5
OTP_RESEND_SECONDS = 60
OTP_MAX_SENDS_PER_HOUR = 5
TRUSTED_DEVICE_COOKIE = "device_id"
TRUSTED_DEVICE_DAYS = 180

# Soft delete: how long deleted things can be restored before the daily clean-up erases them.
ACCOUNT_RESTORE_DAYS = 30
TASK_RESTORE_DAYS = 7
# example.com / *.test addresses never resolve; allow them only while developing.
EMAIL_ALLOW_RESERVED_DOMAINS = False


AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 12},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
    {"NAME": "apps.users.validators.PasswordComplexityValidator"},
]


LANGUAGE_CODE = "en-us"

TIME_ZONE = "Asia/Yangon"

USE_I18N = True

USE_TZ = True


STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"


# Auth events (sign-up, login with IP, logout) go to the console as well as the AuthEvent table.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "{asctime} {levelname} {name}: {message}", "style": "{"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "loggers": {"apps.users.auth": {"handlers": ["console"], "level": "INFO", "propagate": False}},
}
