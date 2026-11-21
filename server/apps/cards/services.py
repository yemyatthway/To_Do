from datetime import datetime, time

from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from apps.tasks.serializers import user_zone

from .models import Card, Deck
from .scheduling import ANSWERS, next_state, previews

MAX_DECKS = 200
MAX_CARDS_PER_DECK = 5000
MAX_IMPORT = 2000
MAX_TITLE = 80
MAX_FRONT = 1000
MAX_BACK = 2000
NEW_PER_DAY = 20
STUDY_BATCH = 200


def day_start(user, now):
    """Midnight today in the person's own time zone."""
    zone = user_zone(user)
    return datetime.combine(now.astimezone(zone).date(), time.min, tzinfo=zone)


def decks_with_counts(user, now=None):
    now = now or timezone.now()
    today = day_start(user, now)
    return Deck.objects.filter(owner=user).annotate(
        card_count=Count("cards"),
        due_count=Count("cards", filter=Q(cards__due_at__lte=now)),
        unseen_count=Count("cards", filter=Q(cards__first_reviewed_at__isnull=True)),
        started_today=Count("cards", filter=Q(cards__first_reviewed_at__gte=today)),
    )


def new_today(deck):
    """How many new cards this deck still lets you start today."""
    return max(0, min(deck.unseen_count, NEW_PER_DAY - deck.started_today))


def deck_for(user, deck_id):
    deck = decks_with_counts(user).filter(pk=deck_id).first()
    if not deck:
        raise NotFound("That deck doesn't exist.")
    return deck


def card_for(user, card_id):
    card = Card.objects.filter(pk=card_id, deck__owner=user).select_related("deck").first()
    if not card:
        raise NotFound("That card doesn't exist.")
    return card


def clean_title(title):
    title = (title or "").strip() if isinstance(title, str) else ""
    if not title:
        raise ValidationError({"title": ["Give the deck a name."]})
    if len(title) > MAX_TITLE:
        raise ValidationError({"title": [f"Keep the name under {MAX_TITLE} characters."]})
    return title


def clean_side(value, field, limit):
    value = value.strip() if isinstance(value, str) else ""
    if not value:
        raise ValidationError({field: ["Write something on both sides of the card."]})
    if len(value) > limit:
        raise ValidationError({field: [f"Keep each side under {limit} characters."]})
    return value


def create_deck(user, title):
    title = clean_title(title)
    if Deck.objects.filter(owner=user).count() >= MAX_DECKS:
        raise ValidationError({"title": [f"You can have up to {MAX_DECKS} decks."]})
    return Deck.objects.create(owner=user, title=title)


def rename_deck(deck, title):
    deck.title = clean_title(title)
    deck.save(update_fields=["title", "updated_at"])


def _room_for(deck, count):
    have = deck.cards.count()
    if have + count > MAX_CARDS_PER_DECK:
        raise ValidationError({"cards": [f"A deck can hold up to {MAX_CARDS_PER_DECK} cards."]})


def add_card(deck, front, back):
    front, back = clean_side(front, "front", MAX_FRONT), clean_side(back, "back", MAX_BACK)
    _room_for(deck, 1)
    card = Card.objects.create(deck=deck, front=front, back=back)
    Deck.objects.filter(pk=deck.pk).update(updated_at=timezone.now())
    return card


def edit_card(card, data):
    if "front" in data:
        card.front = clean_side(data.get("front"), "front", MAX_FRONT)
    if "back" in data:
        card.back = clean_side(data.get("back"), "back", MAX_BACK)
    card.save(update_fields=["front", "back"])


def import_cards(deck, rows):
    """rows: [[front, back], ...] from a spreadsheet. Blank rows are skipped; all or nothing."""
    if not isinstance(rows, list) or not rows:
        raise ValidationError({"cards": ["The file has no cards in it."]})
    if len(rows) > MAX_IMPORT:
        raise ValidationError({"cards": [f"Import up to {MAX_IMPORT} cards at a time."]})
    cards = []
    for number, row in enumerate(rows, start=1):
        if not isinstance(row, list) or len(row) < 2:
            raise ValidationError({"cards": [f"Row {number} needs a front and a back."]})
        front, back = (str(v).strip() if v is not None else "" for v in row[:2])
        if not front and not back:
            continue
        if not front or not back:
            raise ValidationError({"cards": [f"Row {number} needs a front and a back."]})
        if len(front) > MAX_FRONT or len(back) > MAX_BACK:
            raise ValidationError({"cards": [f"Row {number} is too long."]})
        cards.append(Card(deck=deck, front=front, back=back))
    if not cards:
        raise ValidationError({"cards": ["The file has no cards in it."]})
    with transaction.atomic():
        Deck.objects.select_for_update().filter(pk=deck.pk).first()
        _room_for(deck, len(cards))
        Card.objects.bulk_create(cards)
        Deck.objects.filter(pk=deck.pk).update(updated_at=timezone.now())
    return len(cards)


def study_queue(user, deck, now=None):
    """Cards to study now: the ones due (oldest first), then today's new ones."""
    now = now or timezone.now()
    due = list(deck.cards.filter(due_at__lte=now).order_by("due_at", "id")[:STUDY_BATCH])
    room = min(new_today(deck), STUDY_BATCH - len(due))
    fresh = list(deck.cards.filter(first_reviewed_at__isnull=True).order_by("created_at", "id")[:max(0, room)])
    return due + fresh


def review(card, answer, now=None):
    if answer not in ANSWERS:
        raise ValidationError({"answer": ["Choose Again, Hard, Good or Easy."]})
    now = now or timezone.now()
    for field, value in next_state(card, answer, now).items():
        setattr(card, field, value)
    card.save(update_fields=["ease", "interval_days", "reps", "lapses", "due_at", "last_reviewed_at", "first_reviewed_at"])
    return card


def card_data(card, now=None, with_previews=False):
    data = {
        "id": card.pk, "deck": card.deck_id, "front": card.front, "back": card.back,
        "is_new": card.is_new, "due_at": card.due_at, "interval_days": card.interval_days,
        "reps": card.reps, "lapses": card.lapses, "created_at": card.created_at,
    }
    if with_previews:
        data["previews"] = previews(card, now or timezone.now())
    return data


def deck_data(deck):
    return {
        "id": deck.pk, "title": deck.title, "created_at": deck.created_at, "updated_at": deck.updated_at,
        "card_count": deck.card_count, "due_count": deck.due_count, "new_count": new_today(deck),
    }


def total_due(user):
    """Cards waiting across all decks (due now plus today's new ones), for the Today list."""
    return sum(d.due_count + new_today(d) for d in decks_with_counts(user))
