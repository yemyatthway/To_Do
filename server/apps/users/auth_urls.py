from django.urls import path

from .auth_apis import (
    ChangePasswordApi,
    DeviceDeleteApi,
    DevicesApi,
    EmailCheckApi,
    UsernameCheckApi,
    LoginApi,
    LoginResendApi,
    LoginVerifyApi,
    LogoutApi,
    MeApi,
    RefreshApi,
    RegisterApi,
    ResendVerifyEmailApi,
    VerifyEmailApi,
)

app_name = "auth"

urlpatterns = [
    path("register/", RegisterApi.as_view(), name="register"),
    path("check-email/", EmailCheckApi.as_view(), name="check-email"),
    path("check-username/", UsernameCheckApi.as_view(), name="check-username"),
    path("login/", LoginApi.as_view(), name="login"),
    path("login/verify/", LoginVerifyApi.as_view(), name="login-verify"),
    path("login/resend/", LoginResendApi.as_view(), name="login-resend"),
    path("verify-email/", VerifyEmailApi.as_view(), name="verify-email"),
    path("verify-email/resend/", ResendVerifyEmailApi.as_view(), name="verify-email-resend"),
    path("refresh/", RefreshApi.as_view(), name="refresh"),
    path("logout/", LogoutApi.as_view(), name="logout"),
    path("me/", MeApi.as_view(), name="me"),
    path("devices/", DevicesApi.as_view(), name="devices"),
    path("devices/<int:pk>/", DeviceDeleteApi.as_view(), name="device-delete"),
    path("change-password/", ChangePasswordApi.as_view(), name="change-password"),
]
