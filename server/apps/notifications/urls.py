from django.urls import path

from .views import ReminderStatusView, SendDueRemindersView, SubscribeView, TestPushView, VapidPublicKeyView

urlpatterns = [
    path("vapid-public-key/", VapidPublicKeyView.as_view()),
    path("subscribe/", SubscribeView.as_view()),
    path("test/", TestPushView.as_view()),
    path("status/", ReminderStatusView.as_view()),
    path("send-due/", SendDueRemindersView.as_view()),
]
