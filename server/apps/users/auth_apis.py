"""
Login/logout like afm_sys: the access token is returned in the body (the client keeps it in memory),
the refresh token lives in an httpOnly cookie that JavaScript can't read. Refresh rotates the token
and blacklists the old one; logout blacklists the current one and clears the cookie.
"""

from urllib.parse import urlsplit

from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken

from . import events, mail, otp
from .email_check import check_email, email_checks
from .models import AuthEvent, EmailCode, TrustedDevice, User
from .serializers import (
    ChallengeSerializer,
    ChangePasswordSerializer,
    CodeSerializer,
    DeleteAccountSerializer,
    EmailCheckSerializer,
    LoginCodeSerializer,
    LoginSerializer,
    RegisterSerializer,
    TrustedDeviceSerializer,
    UserSerializer,
)
from .services import change_password, delete_account, restore_account, restore_deadline, user_login


def _client_ip(request):
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


def _trusted_origin(request):
    """Cookie-authenticated endpoints only accept requests from our own frontend (CSRF protection)."""
    origin = request.headers.get("Origin")
    if not origin:
        # Browsers always send Origin on cross-site POSTs; its absence means a same-origin or non-browser call.
        return True
    if origin in settings.TRUSTED_FRONTEND_ORIGINS:
        return True
    return urlsplit(origin).netloc == request.get_host()


def _set_refresh_cookie(response, refresh):
    response.set_cookie(
        settings.REFRESH_COOKIE_NAME,
        str(refresh),
        max_age=int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds()),
        httponly=True,
        secure=settings.REFRESH_COOKIE_SECURE,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
        path=settings.REFRESH_COOKIE_PATH,
    )


def _clear_refresh_cookie(response):
    response.delete_cookie(
        settings.REFRESH_COOKIE_NAME,
        path=settings.REFRESH_COOKIE_PATH,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
    )


def _session_response(user, response_status=status.HTTP_200_OK):
    refresh = RefreshToken.for_user(user)
    response = Response({"access": str(refresh.access_token), "user": UserSerializer(user).data}, status=response_status)
    _set_refresh_cookie(response, refresh)
    return response


def _forbidden_origin():
    return Response({"detail": "Invalid request origin."}, status=status.HTTP_403_FORBIDDEN)


class RegisterApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "register"

    def post(self, request):
        if not _trusted_origin(request):
            return _forbidden_origin()
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        events.record(user, AuthEvent.Kind.SIGNUP)
        otp.issue_code(user, EmailCode.Purpose.VERIFY_EMAIL)
        response = _session_response(user, status.HTTP_201_CREATED)
        # The browser that created the account doesn't need a sign-in code later.
        otp.trust_device(request, response, user, ip=_client_ip(request))
        return response


class LoginApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "login"

    def post(self, request):
        if not _trusted_origin(request):
            return _forbidden_origin()
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            user = user_login(
                email=serializer.validated_data["email"],
                password=serializer.validated_data["password"],
                ip=_client_ip(request),
            )
        except AuthenticationFailed as exc:
            # DRF downgrades 401 to 403 on views without an auth scheme; keep it a 401.
            return Response({"detail": exc.detail}, status=status.HTTP_401_UNAUTHORIZED)

        restoring = False
        if user.deleted_at:
            if timezone.now() >= restore_deadline(user):
                # Past the restore window (the clean-up just hasn't run yet): it's gone.
                return Response({"detail": "Invalid email or password."}, status=status.HTTP_401_UNAUTHORIZED)
            if not serializer.validated_data["restore"]:
                return Response({"account_deleted": True, "restore_until": restore_deadline(user)})
            restoring = True

        device = otp.find_trusted(request, user)
        if device is None and user.email_verified:
            # Right password, unknown browser: prove it's really you with a code sent to your email.
            # (Deleting an account forgets its devices, so restoring always takes this step.)
            try:
                challenge, resend_in = otp.start_login(user, device=otp.device_name(request.headers.get("User-Agent")), restore=restoring)
            except ValidationError as exc:  # hourly cap reached
                return Response(exc.detail, status=status.HTTP_429_TOO_MANY_REQUESTS)
            return Response(
                {
                    "two_factor_required": True,
                    "challenge": challenge,
                    "email": otp.mask_email(user.email),
                    "resend_in": resend_in,
                    "expires_at": otp.code_expires_at(user, EmailCode.Purpose.LOGIN),
                }
            )
        if restoring:
            restore_account(user=user)
            events.record(user, AuthEvent.Kind.RESTORED)
        if device:
            device.save(update_fields=["last_used_at"])
        # (An unverified account signs in straight away; the app then asks for its email code first.)
        events.record(user, AuthEvent.Kind.LOGIN, ip=_client_ip(request))
        mail.send_welcome_once(user)
        return _session_response(user)


class LoginVerifyApi(APIView):
    """Second step of a new-device sign-in. Body: {challenge, code}."""

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "otp"

    def post(self, request):
        if not _trusted_origin(request):
            return _forbidden_origin()
        serializer = LoginCodeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user, nonce, restoring = otp.read_challenge(serializer.validated_data["challenge"])
        otp.check_code(user, EmailCode.Purpose.LOGIN, serializer.validated_data["code"], challenge=nonce)
        if restoring and user.deleted_at:
            restore_account(user=user)
            events.record(user, AuthEvent.Kind.RESTORED)
        events.record(user, AuthEvent.Kind.LOGIN, ip=_client_ip(request))
        mail.send_welcome_once(user)
        response = _session_response(user)
        otp.trust_device(request, response, user, ip=_client_ip(request))
        return response


class LoginResendApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "otp"

    def post(self, request):
        if not _trusted_origin(request):
            return _forbidden_origin()
        serializer = ChallengeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user, nonce, _ = otp.read_challenge(serializer.validated_data["challenge"])
        resend_in = otp.issue_code(user, EmailCode.Purpose.LOGIN, challenge=nonce, device=otp.device_name(request.headers.get("User-Agent")))
        return Response({"resend_in": resend_in, "expires_at": otp.code_expires_at(user, EmailCode.Purpose.LOGIN, nonce)})


class VerifyEmailApi(APIView):
    """Confirm your email with the code we sent. Body: {code}."""

    permission_classes = [IsAuthenticated]
    throttle_scope = "otp"

    def post(self, request):
        user = request.user
        if user.email_verified:
            return Response(UserSerializer(user).data)
        serializer = CodeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        otp.check_code(user, EmailCode.Purpose.VERIFY_EMAIL, serializer.validated_data["code"])
        user.email_verified_at = timezone.now()
        user.save(update_fields=["email_verified_at"])
        mail.send_welcome_once(user)  # sign-up is complete
        response = Response(UserSerializer(user).data)
        if otp.find_trusted(request, user) is None:
            otp.trust_device(request, response, user, ip=_client_ip(request))
        return response


class ResendVerifyEmailApi(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "otp"

    def post(self, request):
        if request.user.email_verified:
            return Response({"detail": "Your email is already verified."}, status=status.HTTP_400_BAD_REQUEST)
        resend_in = otp.issue_code(request.user, EmailCode.Purpose.VERIFY_EMAIL)
        return Response({"resend_in": resend_in, "expires_at": otp.code_expires_at(request.user, EmailCode.Purpose.VERIFY_EMAIL)})


class EmailCheckApi(APIView):
    """Live check while typing an email: format, a domain that takes mail, no throwaway inboxes."""

    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "email_check"

    def post(self, request):
        serializer = EmailCheckSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]
        ok, message, suggestion = check_email(email)
        return Response({"ok": ok, "message": message, "suggestion": suggestion, "checks": email_checks(email)})


class DevicesApi(APIView):
    """Browsers that can sign in without an email code."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        devices = TrustedDevice.objects.filter(user=request.user)
        return Response(TrustedDeviceSerializer(devices, many=True, context={"current_hash": otp.current_device_hash(request)}).data)


class DeviceDeleteApi(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, pk):
        deleted, _ = TrustedDevice.objects.filter(user=request.user, pk=pk).delete()
        if not deleted:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RefreshApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        if not _trusted_origin(request):
            return _forbidden_origin()
        token = request.COOKIES.get(settings.REFRESH_COOKIE_NAME)
        if not token:
            # Simply logged out: not an error, so the app's startup check doesn't log one.
            return Response(status=status.HTTP_204_NO_CONTENT)

        serializer = TokenRefreshSerializer(data={"refresh": token})
        try:
            serializer.is_valid(raise_exception=True)
        except (TokenError, AuthenticationFailed, User.DoesNotExist):
            # Expired, blacklisted (already rotated or logged out), or the user no longer exists.
            response = Response({"detail": "Your session has expired. Log in again."}, status=status.HTTP_401_UNAUTHORIZED)
            _clear_refresh_cookie(response)
            return response

        response = Response({"access": serializer.validated_data["access"]})
        if "refresh" in serializer.validated_data:
            _set_refresh_cookie(response, serializer.validated_data["refresh"])
        return response


class LogoutApi(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        if not _trusted_origin(request):
            return _forbidden_origin()
        token = request.COOKIES.get(settings.REFRESH_COOKIE_NAME)
        if token:
            try:
                refresh = RefreshToken(token)
                user = User.objects.filter(pk=refresh.payload.get("user_id")).first()
                refresh.blacklist()
                if user:
                    events.record(user, AuthEvent.Kind.LOGOUT)
            except TokenError:
                pass
        response = Response(status=status.HTTP_204_NO_CONTENT)
        _clear_refresh_cookie(response)
        return response


class MeApi(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user).data)

    def patch(self, request):
        old_email = request.user.email
        serializer = UserSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        if user.email != old_email:
            # A new address has to be confirmed too.
            user.email_verified_at = None
            user.save(update_fields=["email_verified_at"])
            try:
                otp.issue_code(user, EmailCode.Purpose.VERIFY_EMAIL)
            except ValidationError:
                pass  # asked very recently; "Send again" works once the wait is over
        return Response(UserSerializer(user).data)

    def delete(self, request):
        """Delete your own account. Body: {password}."""
        serializer = DeleteAccountSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = delete_account(user=request.user, password=serializer.validated_data["password"])
        events.record(user, AuthEvent.Kind.DELETED)
        response = Response(status=status.HTTP_204_NO_CONTENT)
        _clear_refresh_cookie(response)
        response.delete_cookie(settings.TRUSTED_DEVICE_COOKIE, path=settings.REFRESH_COOKIE_PATH, samesite=settings.REFRESH_COOKIE_SAMESITE)
        return response


class ChangePasswordApi(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        change_password(
            user=request.user,
            old_password=serializer.validated_data["old_password"],
            new_password=serializer.validated_data["new_password"],
        )
        return Response(status=status.HTTP_204_NO_CONTENT)
