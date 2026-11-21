from django.urls import path

from . import views

urlpatterns = [
    path("summary/", views.SummaryApi.as_view()),
    path("decks/", views.DecksApi.as_view()),
    path("decks/<int:deck_id>/", views.DeckApi.as_view()),
    path("decks/<int:deck_id>/cards/", views.DeckCardsApi.as_view()),
    path("decks/<int:deck_id>/cards/import/", views.ImportCardsApi.as_view()),
    path("decks/<int:deck_id>/study/", views.StudyApi.as_view()),
    path("cards/<int:card_id>/", views.CardApi.as_view()),
    path("cards/<int:card_id>/review/", views.ReviewApi.as_view()),
]
