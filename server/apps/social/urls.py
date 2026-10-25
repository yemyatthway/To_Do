from django.urls import path

from . import views

urlpatterns = [
    path("users/", views.UserSearchApi.as_view()),
    path("friends/", views.FriendsApi.as_view()),
    path("friends/requests/", views.FriendRequestApi.as_view()),
    path("friends/<int:friendship_id>/accept/", views.FriendAcceptApi.as_view()),
    path("friends/<int:friendship_id>/", views.FriendshipDeleteApi.as_view()),
    path("shares/", views.SharesApi.as_view()),
    path("remind/", views.RemindFriendApi.as_view()),
    path("shares/<int:share_id>/add/", views.ShareAddApi.as_view()),
    path("shares/<int:share_id>/dismiss/", views.ShareDismissApi.as_view()),
    path("summary/", views.SocialSummaryApi.as_view()),
]
