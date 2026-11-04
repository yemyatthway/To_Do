from django.urls import path

from . import views

urlpatterns = [
    path("", views.ChatListApi.as_view()),
    path("with/<int:user_id>/", views.ChatOpenApi.as_view()),
    path("<int:conversation_id>/messages/", views.MessagesApi.as_view()),
    path("<int:conversation_id>/messages/<int:message_id>/", views.MessageApi.as_view()),
    path("<int:conversation_id>/messages/<int:message_id>/react/", views.ReactApi.as_view()),
    path("<int:conversation_id>/scheduled/", views.ScheduledApi.as_view()),
    path("<int:conversation_id>/scheduled/<int:item_id>/", views.ScheduledOneApi.as_view()),
    path("<int:conversation_id>/read/", views.ReadApi.as_view()),
    path("<int:conversation_id>/clear/", views.ClearApi.as_view()),
]
