from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from . import services


class DecksApi(APIView):
    """GET: your decks with how many cards are waiting. POST {title}: make a deck."""

    throttle_scope = "cards"

    def get(self, request):
        return Response({"decks": [services.deck_data(d) for d in services.decks_with_counts(request.user)]})

    def post(self, request):
        deck = services.create_deck(request.user, request.data.get("title"))
        return Response(services.deck_data(services.deck_for(request.user, deck.pk)), status=status.HTTP_201_CREATED)


class DeckApi(APIView):
    throttle_scope = "cards"

    def get(self, request, deck_id):
        deck = services.deck_for(request.user, deck_id)
        data = services.deck_data(deck)
        data["cards"] = [services.card_data(c) for c in deck.cards.all()]
        return Response(data)

    def patch(self, request, deck_id):
        deck = services.deck_for(request.user, deck_id)
        services.rename_deck(deck, request.data.get("title"))
        return Response(services.deck_data(services.deck_for(request.user, deck_id)))

    def delete(self, request, deck_id):
        services.deck_for(request.user, deck_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class DeckCardsApi(APIView):
    """POST {front, back}: add a card to the deck."""

    throttle_scope = "cards"

    def post(self, request, deck_id):
        deck = services.deck_for(request.user, deck_id)
        card = services.add_card(deck, request.data.get("front"), request.data.get("back"))
        return Response(services.card_data(card), status=status.HTTP_201_CREATED)


class ImportCardsApi(APIView):
    """POST {cards: [[front, back], ...]}: add many cards at once (from Excel or CSV)."""

    throttle_scope = "card_import"

    def post(self, request, deck_id):
        deck = services.deck_for(request.user, deck_id)
        added = services.import_cards(deck, request.data.get("cards"))
        return Response({"added": added}, status=status.HTTP_201_CREATED)


class StudyApi(APIView):
    """GET: the cards to study now, each with when it would come back for every answer."""

    throttle_scope = "cards"

    def get(self, request, deck_id):
        now = timezone.now()
        deck = services.deck_for(request.user, deck_id)
        cards = services.study_queue(request.user, deck, now)
        return Response({
            "deck": services.deck_data(deck),
            "cards": [services.card_data(c, now, with_previews=True) for c in cards],
        })


class CardApi(APIView):
    throttle_scope = "cards"

    def patch(self, request, card_id):
        card = services.card_for(request.user, card_id)
        services.edit_card(card, request.data)
        return Response(services.card_data(card))

    def delete(self, request, card_id):
        services.card_for(request.user, card_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ReviewApi(APIView):
    """POST {answer: again|hard|good|easy}: grade a card; it comes back later."""

    throttle_scope = "cards"

    def post(self, request, card_id):
        now = timezone.now()
        card = services.review(services.card_for(request.user, card_id), request.data.get("answer"), now)
        return Response(services.card_data(card, now, with_previews=True))


class SummaryApi(APIView):
    """GET: {due}, how many cards are waiting across all your decks."""

    throttle_scope = "cards"

    def get(self, request):
        return Response({"due": services.total_due(request.user)})
