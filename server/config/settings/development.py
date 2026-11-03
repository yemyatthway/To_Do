from .base import *  # noqa: F403
from .base import BASE_DIR, env

DEBUG = True

ALLOWED_HOSTS = ["localhost", "127.0.0.1"]

CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    # `npm run preview` (production build)
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]
CORS_ALLOW_CREDENTIALS = True

TRUSTED_FRONTEND_ORIGINS = CORS_ALLOWED_ORIGINS

# Local http: the refresh cookie can't be Secure.
REFRESH_COOKIE_SECURE = False
EMAIL_ALLOW_RESERVED_DOMAINS = True
# On this computer, emails and login codes are saved to server/.dev-emails instead of being sent,
# so testing can't use up the sending quota or email real people. To try real delivery, set
# DEV_SEND_REAL_EMAIL=1 in server/.env. Production never reads this file.
if not env.bool("DEV_SEND_REAL_EMAIL", default=False):
    EMAIL_BACKEND = "django.core.mail.backends.filebased.EmailBackend"
    EMAIL_FILE_PATH = BASE_DIR / ".dev-emails"
# Chat works locally without CHAT_ENCRYPTION_KEYS (a key derived from SECRET_KEY). Never in production.
CHAT_ALLOW_DERIVED_KEY = True
