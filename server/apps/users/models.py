from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone as dj_timezone


class AllUsersManager(BaseUserManager):
    """Every account, including ones deleted in the last 30 days (still restorable)."""

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("Email is required.")
        email = self.normalize_email(email).strip().lower()
        if not extra_fields.get("username"):
            from .usernames import suggest

            extra_fields["username"] = suggest(extra_fields.get("full_name", ""), email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.password_changed_at = dj_timezone.now()
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        return self.create_user(email, password, **extra_fields)


class UserManager(AllUsersManager):
    """The default: deleted accounts don't exist for the app (login, tokens, search, admin counts)."""

    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)


class User(AbstractBaseUser, PermissionsMixin):
    # Always stored lowercase (see save), so this is case-insensitive too.
    email = models.EmailField(max_length=160, unique=True)
    full_name = models.CharField(max_length=160, blank=True)
    # Public and unique, stored lowercase (see usernames.py). Accounts from before usernames got one
    # made from their name; `username_confirmed_at` stays empty until they've chosen or kept it.
    username = models.CharField(max_length=20, unique=True)
    username_confirmed_at = models.DateTimeField(null=True, blank=True)
    # IANA name ("Asia/Yangon"), kept in sync with the user's device so reminder text shows their local time.
    timezone = models.CharField(max_length=64, blank=True)
    reminders_enabled = models.BooleanField(default=False)
    tutorial_seen = models.BooleanField(default=False)
    # Friends may put tasks straight into this list (with reminders); off = they land in the inbox.
    friends_can_add_tasks = models.BooleanField(default=True)
    email_verified_at = models.DateTimeField(null=True, blank=True)
    # When the welcome email went out (once per account; see mail.send_welcome_once).
    welcomed_at = models.DateTimeField(null=True, blank=True)

    password_changed_at = models.DateTimeField(null=True, blank=True)
    failed_login_count = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)
    last_login_at = models.DateTimeField(null=True, blank=True)
    last_login_ip = models.GenericIPAddressField(null=True, blank=True)

    # A banned account has is_active=False plus when/why, so admins can tell it apart from other inactive states.
    is_active = models.BooleanField(default=True)
    banned_at = models.DateTimeField(null=True, blank=True)
    ban_reason = models.CharField(max_length=255, blank=True)
    # Soft delete: hidden everywhere and restorable by logging in; erased for good after
    # settings.ACCOUNT_RESTORE_DAYS by the daily clean-up.
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(default=dj_timezone.now)

    objects = UserManager()
    all_objects = AllUsersManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    class Meta:
        db_table = "users"
        ordering = ["email"]
        # Following a foreign key (e.g. an old log row's user) must still reach a deleted account.
        base_manager_name = "all_objects"

    def save(self, *args, **kwargs):
        if self.email:
            self.email = self.email.strip().lower()
        if self.username:
            self.username = self.username.strip().lstrip("@").lower()
        super().save(*args, **kwargs)

    def __str__(self):
        return self.email

    @property
    def email_verified(self):
        return self.email_verified_at is not None


class EmailCode(models.Model):
    """A 6-digit code sent by email. Only a hash is stored; it expires and allows a few tries."""

    class Purpose(models.TextChoices):
        VERIFY_EMAIL = "verify", "Verify email"
        LOGIN = "login", "New device sign-in"

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="email_codes")
    purpose = models.CharField(max_length=10, choices=Purpose.choices)
    code_hash = models.CharField(max_length=64)
    # Sign-in codes are tied to the login attempt they were sent for.
    challenge = models.CharField(max_length=64, blank=True, db_index=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "email_codes"
        indexes = [models.Index(fields=["user", "purpose", "created_at"])]


class TrustedDevice(models.Model):
    """A browser that has passed a sign-in code (or created the account). Identified by a random
    token in an httpOnly cookie; only its hash is stored."""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="trusted_devices")
    token_hash = models.CharField(max_length=64, db_index=True)
    name = models.CharField(max_length=120, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "trusted_devices"
        ordering = ["-last_used_at"]


class AuthEvent(models.Model):
    """Audit log of account creation, logins, logouts, deletion and restore. The IP address is recorded for logins only."""

    class Kind(models.TextChoices):
        SIGNUP = "signup", "Account created"
        LOGIN = "login", "Logged in"
        LOGOUT = "logout", "Logged out"
        DELETED = "deleted", "Deleted account"
        RESTORED = "restored", "Restored account"

    # Kept (with the email) if the user is deleted later, so the log stays complete.
    user = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name="auth_events")
    email = models.EmailField(max_length=160)
    kind = models.CharField(max_length=10, choices=Kind.choices)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "auth_events"
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return f"{self.email} {self.kind} {self.created_at:%Y-%m-%d %H:%M}"
