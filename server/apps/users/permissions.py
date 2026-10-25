from rest_framework.permissions import IsAuthenticated


class IsVerified(IsAuthenticated):
    """Signed in and has confirmed their email. The default for the app's APIs; the account
    endpoints a not-yet-verified person needs (me, verify, logout) use IsAuthenticated instead."""

    message = "Verify your email to continue."
    code = "email_unverified"

    def has_permission(self, request, view):
        return super().has_permission(request, view) and request.user.email_verified
