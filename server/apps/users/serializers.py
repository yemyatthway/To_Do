from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from .email_check import check_email
from .otp import code_expires_at
from .models import TrustedDevice, User
from .validators import is_valid_timezone


def _validate_new_password(value, user=None):
    try:
        validate_password(value, user=user)
    except DjangoValidationError as exc:
        raise serializers.ValidationError(list(exc.messages))
    return value


def _validate_deliverable(value):
    ok, message, _ = check_email(value)
    if not ok:
        raise serializers.ValidationError(message)
    return value


def _validate_timezone(value):
    if value and not is_valid_timezone(value):
        raise serializers.ValidationError("Unknown time zone.")
    return value


class UserSerializer(serializers.ModelSerializer):
    # Until the email is confirmed: when the emailed code runs out (for the countdown), else null.
    code_expires_at = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "email", "email_verified", "code_expires_at", "full_name", "timezone", "reminders_enabled", "tutorial_seen", "is_staff", "date_joined"]
        read_only_fields = ["id", "email_verified", "is_staff", "date_joined"]

    def get_code_expires_at(self, user):
        if user.email_verified or not user.pk:
            return None
        return code_expires_at(user, "verify")

    def validate_email(self, value):
        value = value.strip().lower()
        # Includes recently deleted accounts: their email stays reserved while they can be restored.
        taken = User.all_objects.filter(email__iexact=value)
        if self.instance:
            taken = taken.exclude(pk=self.instance.pk)
        if taken.exists():
            raise serializers.ValidationError("An account with this email already exists.")
        if self.instance and value == self.instance.email:
            return value
        return _validate_deliverable(value)

    def validate_full_name(self, value):
        return value.strip()

    def validate_timezone(self, value):
        return _validate_timezone(value)


class RegisterSerializer(serializers.Serializer):
    full_name = serializers.CharField(max_length=160)
    email = serializers.EmailField(max_length=160)
    password = serializers.CharField(trim_whitespace=False, write_only=True)
    timezone = serializers.CharField(max_length=64, required=False, allow_blank=True)

    def validate_full_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Enter your name.")
        return value

    def validate_email(self, value):
        value = value.strip().lower()
        existing = User.all_objects.filter(email__iexact=value).first()
        if existing and existing.deleted_at:
            raise serializers.ValidationError("This email's account was deleted recently. Log in to restore it.")
        if existing:
            raise serializers.ValidationError("An account with this email already exists.")
        return _validate_deliverable(value)

    def validate_timezone(self, value):
        return _validate_timezone(value)

    def validate(self, attrs):
        _validate_new_password(attrs["password"], User(email=attrs["email"], full_name=attrs["full_name"]))
        return attrs

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(trim_whitespace=False, write_only=True)
    # Set after the app asked "Restore this deleted account?" and the person said yes.
    restore = serializers.BooleanField(required=False, default=False)


class ChangePasswordSerializer(serializers.Serializer):
    old_password = serializers.CharField(trim_whitespace=False, write_only=True)
    new_password = serializers.CharField(trim_whitespace=False, write_only=True)

    def validate_new_password(self, value):
        return _validate_new_password(value, self.context["request"].user)


class DeleteAccountSerializer(serializers.Serializer):
    password = serializers.CharField(trim_whitespace=False, write_only=True)


class CodeSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=12)


class LoginCodeSerializer(CodeSerializer):
    challenge = serializers.CharField(max_length=300)


class ChallengeSerializer(serializers.Serializer):
    challenge = serializers.CharField(max_length=300)


class EmailCheckSerializer(serializers.Serializer):
    email = serializers.CharField(max_length=200, allow_blank=True)


class TrustedDeviceSerializer(serializers.ModelSerializer):
    current = serializers.SerializerMethodField()

    class Meta:
        model = TrustedDevice
        fields = ["id", "name", "ip_address", "created_at", "last_used_at", "current"]

    def get_current(self, device):
        return device.token_hash == self.context.get("current_hash")
