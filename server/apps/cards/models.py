from django.conf import settings
from django.db import models


class Deck(models.Model):
    """A set of flashcards that belongs to one person."""

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="decks")
    title = models.CharField(max_length=80)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["title", "id"]

    def __str__(self):
        return self.title


class Card(models.Model):
    """One question and answer, plus where it is in the review schedule.

    A new card has never been answered (reps == 0, due_at is null). interval_days is 0 while
    the card is still being learned (it comes back in minutes), then a whole number of days.
    """

    deck = models.ForeignKey(Deck, on_delete=models.CASCADE, related_name="cards")
    front = models.TextField(max_length=1000)
    back = models.TextField(max_length=2000)
    created_at = models.DateTimeField(auto_now_add=True)

    due_at = models.DateTimeField(null=True, blank=True)
    interval_days = models.PositiveIntegerField(default=0)
    ease = models.FloatField(default=2.5)
    reps = models.PositiveIntegerField(default=0)
    lapses = models.PositiveIntegerField(default=0)
    first_reviewed_at = models.DateTimeField(null=True, blank=True)
    last_reviewed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["deck", "due_at"])]

    @property
    def is_new(self):
        return self.first_reviewed_at is None
