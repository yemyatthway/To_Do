from django.urls import path

from . import views

urlpatterns = [
    path("", views.ChatListApi.as_view()),
    path("with/<int:user_id>/", views.ChatOpenApi.as_view()),
    path("<int:conversation_id>/messages/", views.MessagesApi.as_view()),
    path("<int:conversation_id>/messages/<int:message_id>/", views.MessageDeleteApi.as_view()),
    path("<int:conversation_id>/read/", views.ReadApi.as_view()),
]
