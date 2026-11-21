from datetime import timedelta

from django.core.cache import cache
from django.test import SimpleTestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.users.models import User

from . import services
from .models import Card, Deck
from .scheduling import next_state, previews

PASSWORD = "CorrectHorse-Battery9!"
DAY = 86400


def person(name):
    return User.objects.create_user(f"{name}@example.com", PASSWORD, full_name=name.title(), email_verified_at=timezone.now())


class SchedulingTests(SimpleTestCase):
    def setUp(self):
        self.now = timezone.now()

    def answer(self, card, *answers):
        for answer in answers:
            for field, value in next_state(card, answer, self.now).items():
                setattr(card, field, value)
        return card

    def test_new_card_waits(self):
        waits = previews(Card(), self.now)
        self.assertEqual(waits, {"again": 60, "hard": 360, "good": DAY, "easy": 4 * DAY})

    def test_good_answers_grow_the_gap(self):
        card = self.answer(Card(), "good")
        self.assertEqual(card.interval_days, 1)
        self.assertEqual(self.answer(card, "good").interval_days, 3)
        self.assertEqual(self.answer(card, "good").interval_days, 8)  # 3 x 2.5
        self.assertEqual(self.answer(card, "good").interval_days, 20)
        self.assertEqual(card.reps, 4)
        self.assertIsNotNone(card.first_reviewed_at)

    def test_forgetting_goes_back_to_learning(self):
        card = self.answer(Card(), "good", "good", "good")
        card = self.answer(card, "again")
        self.assertEqual((card.interval_days, card.lapses, card.ease), (0, 1, 2.3))
        self.assertEqual(card.due_at, self.now + timedelta(minutes=1))
        self.assertEqual(self.answer(card, "good").interval_days, 1)

    def test_again_on_a_new_card_is_not_a_lapse(self):
        card = self.answer(Card(), "again", "again")
        self.assertEqual((card.lapses, card.ease, card.interval_days), (0, 2.5, 0))

    def test_easy_beats_good_and_hard_is_shortest(self):
        card = self.answer(Card(), "good", "good")
        waits = previews(card, self.now)
        self.assertLess(waits["hard"], waits["good"])
        self.assertLess(waits["good"], waits["easy"])
        self.assertGreater(waits["hard"], card.interval_days * DAY - 1)

    def test_ease_never_drops_below_minimum(self):
        card = self.answer(Card(), "good", "good")
        for _ in range(20):
            card = self.answer(card, "good", "again")
        self.assertGreaterEqual(card.ease, 1.3)


class CardsApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.me, self.other = person("mia"), person("omar")
        self.client.force_authenticate(self.me)

    def make_deck(self, title="Anatomy"):
        response = self.client.post("/api/cards/decks/", {"title": title}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        return response.data["id"]

    def add(self, deck_id, front="Femur", back="Thigh bone"):
        return self.client.post(f"/api/cards/decks/{deck_id}/cards/", {"front": front, "back": back}, format="json")

    def test_make_deck_add_cards_and_study(self):
        deck_id = self.make_deck()
        self.assertEqual(self.add(deck_id).status_code, 201)
        self.assertEqual(self.add(deck_id, "Tibia", "Shin bone").status_code, 201)

        decks = self.client.get("/api/cards/decks/").data["decks"]
        self.assertEqual(decks[0]["card_count"], 2)
        self.assertEqual((decks[0]["due_count"], decks[0]["new_count"]), (0, 2))

        study = self.client.get(f"/api/cards/decks/{deck_id}/study/").data
        self.assertEqual([c["front"] for c in study["cards"]], ["Femur", "Tibia"])
        self.assertEqual(study["cards"][0]["previews"]["good"], DAY)

        card_id = study["cards"][0]["id"]
        reviewed = self.client.post(f"/api/cards/cards/{card_id}/review/", {"answer": "good"}, format="json")
        self.assertEqual(reviewed.status_code, 200, reviewed.data)
        self.assertEqual((reviewed.data["interval_days"], reviewed.data["is_new"]), (1, False))
        self.assertEqual(reviewed.data["previews"]["good"], 3 * DAY)

        left = self.client.get(f"/api/cards/decks/{deck_id}/study/").data["cards"]
        self.assertEqual([c["front"] for c in left], ["Tibia"])
        self.assertEqual(self.client.get("/api/cards/summary/").data, {"due": 1})

    def test_forgotten_card_comes_back_first(self):
        deck_id = self.make_deck()
        card_id = self.add(deck_id).data["id"]
        self.add(deck_id, "Tibia", "Shin bone")
        self.client.post(f"/api/cards/cards/{card_id}/review/", {"answer": "again"}, format="json")
        Card.objects.filter(pk=card_id).update(due_at=timezone.now() - timedelta(seconds=1))
        fronts = [c["front"] for c in self.client.get(f"/api/cards/decks/{deck_id}/study/").data["cards"]]
        self.assertEqual(fronts, ["Femur", "Tibia"])

    def test_new_cards_are_limited_per_day(self):
        deck_id = self.make_deck()
        deck = Deck.objects.get(pk=deck_id)
        Card.objects.bulk_create([Card(deck=deck, front=f"Q{i}", back=f"A{i}") for i in range(25)])
        self.assertEqual(len(self.client.get(f"/api/cards/decks/{deck_id}/study/").data["cards"]), services.NEW_PER_DAY)
        first = Card.objects.filter(deck=deck).first()
        self.client.post(f"/api/cards/cards/{first.pk}/review/", {"answer": "easy"}, format="json")
        self.assertEqual(self.client.get("/api/cards/decks/").data["decks"][0]["new_count"], services.NEW_PER_DAY - 1)

    def test_people_only_see_their_own_decks_and_cards(self):
        deck_id = self.make_deck()
        card_id = self.add(deck_id).data["id"]
        self.client.force_authenticate(self.other)
        self.assertEqual(self.client.get("/api/cards/decks/").data["decks"], [])
        self.assertEqual(self.client.get(f"/api/cards/decks/{deck_id}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/cards/decks/{deck_id}/study/").status_code, 404)
        self.assertEqual(self.add(deck_id).status_code, 404)
        self.assertEqual(self.client.patch(f"/api/cards/cards/{card_id}/", {"front": "x"}, format="json").status_code, 404)
        self.assertEqual(self.client.post(f"/api/cards/cards/{card_id}/review/", {"answer": "good"}, format="json").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/cards/decks/{deck_id}/").status_code, 404)
        self.assertTrue(Deck.objects.filter(pk=deck_id).exists())

    def test_rename_edit_and_delete(self):
        deck_id = self.make_deck()
        card_id = self.add(deck_id).data["id"]
        self.assertEqual(self.client.patch(f"/api/cards/decks/{deck_id}/", {"title": "Bones"}, format="json").data["title"], "Bones")
        edited = self.client.patch(f"/api/cards/cards/{card_id}/", {"back": "Longest bone"}, format="json")
        self.assertEqual((edited.data["front"], edited.data["back"]), ("Femur", "Longest bone"))
        self.assertEqual(self.client.delete(f"/api/cards/cards/{card_id}/").status_code, 204)
        self.assertEqual(self.client.delete(f"/api/cards/decks/{deck_id}/").status_code, 204)
        self.assertFalse(Deck.objects.exists())

    def test_rejects_bad_input(self):
        self.assertEqual(self.client.post("/api/cards/decks/", {"title": "  "}, format="json").status_code, 400)
        self.assertEqual(self.client.post("/api/cards/decks/", {"title": "x" * 81}, format="json").status_code, 400)
        deck_id = self.make_deck()
        self.assertEqual(self.add(deck_id, "Femur", "").status_code, 400)
        self.assertEqual(self.add(deck_id, "x" * 1001, "y").status_code, 400)
        card_id = self.add(deck_id).data["id"]
        self.assertEqual(self.client.post(f"/api/cards/cards/{card_id}/review/", {"answer": "maybe"}, format="json").status_code, 400)

    def test_deck_limit(self):
        Deck.objects.bulk_create([Deck(owner=self.me, title=f"D{i}") for i in range(services.MAX_DECKS)])
        self.assertEqual(self.client.post("/api/cards/decks/", {"title": "One more"}, format="json").status_code, 400)

    def test_import_from_a_spreadsheet(self):
        deck_id = self.make_deck()
        url = f"/api/cards/decks/{deck_id}/cards/import/"
        response = self.client.post(url, {"cards": [["Femur", "Thigh bone"], ["", ""], ["Mitosis", 2]]}, format="json")
        self.assertEqual((response.status_code, response.data), (201, {"added": 2}))
        self.assertEqual(list(Card.objects.values_list("back", flat=True)), ["Thigh bone", "2"])

        bad = self.client.post(url, {"cards": [["Ok", "Fine"], ["Only front", ""]]}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertIn("Row 2", str(bad.data))
        self.assertEqual(Card.objects.count(), 2)  # nothing added from the bad file
        self.assertEqual(self.client.post(url, {"cards": []}, format="json").status_code, 400)

    def test_import_respects_the_deck_limit(self):
        deck_id = self.make_deck()
        deck = Deck.objects.get(pk=deck_id)
        Card.objects.bulk_create([Card(deck=deck, front="Q", back="A") for _ in range(services.MAX_CARDS_PER_DECK - 1)])
        response = self.client.post(f"/api/cards/decks/{deck_id}/cards/import/", {"cards": [["a", "b"], ["c", "d"]]}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.add(deck_id).status_code, 201)
        self.assertEqual(self.add(deck_id).status_code, 400)

    def test_day_uses_the_persons_time_zone(self):
        self.me.timezone = "Asia/Yangon"
        self.me.save(update_fields=["timezone"])
        start = services.day_start(self.me, timezone.now())
        self.assertEqual(start.utcoffset(), timedelta(hours=6, minutes=30))
