from django.urls import path

from . import views

urlpatterns = [
    path("", views.WorkspacesApi.as_view()),
    path("invitations/<int:invitation_id>/accept/", views.AcceptInvitationApi.as_view()),
    path("invitations/<int:invitation_id>/decline/", views.DeclineInvitationApi.as_view()),
    path("<int:workspace_id>/", views.WorkspaceApi.as_view()),
    path("<int:workspace_id>/invitations/", views.WorkspaceInvitationsApi.as_view()),
    path("<int:workspace_id>/invitations/<int:invitation_id>/", views.WorkspaceInvitationApi.as_view()),
    path("<int:workspace_id>/members/<int:user_id>/", views.MemberApi.as_view()),
    path("<int:workspace_id>/transfer/", views.TransferApi.as_view()),
    path("<int:workspace_id>/pages/", views.PagesApi.as_view()),
    path("<int:workspace_id>/pages/<int:page_id>/", views.PageApi.as_view()),
    path("<int:workspace_id>/pages/<int:page_id>/restore/", views.RestorePageApi.as_view()),
]
