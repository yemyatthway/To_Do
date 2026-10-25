from django.urls import path

from .views import SendDueRemindersView, SubscribeView, TestPushView, VapidPublicKeyView

urlpatterns = [
    path("vapid-public-key/", VapidPublicKeyView.as_view()),
    path("subscribe/", SubscribeView.as_view()),
    path("test/", TestPushView.as_view()),
    path("send-due/", SendDueRemindersView.as_view()),
]
