"""When a card comes back, from how well it was remembered (a simple SM-2, like Anki).

Answers: again (forgot), hard, good, easy.
- New or still-learning cards come back in minutes for again/hard, then move to days.
- Cards already in days grow by their ease (2.5 to start): 1 day, 3 days, 8 days, 20 days...
- Forgetting a card puts it back to learning and makes it a little harder (lower ease).
"""

from datetime import timedelta

ANSWERS = ("again", "hard", "good", "easy")
MIN_EASE = 1.3
MAX_INTERVAL_DAYS = 3650
AGAIN_MINUTES = 1
HARD_MINUTES = 6


def next_state(card, answer, now):
    """The card's new schedule after this answer (nothing is saved)."""
    ease, interval, reps, lapses = card.ease, card.interval_days, card.reps, card.lapses
    minutes = 0
    learning = interval == 0

    if answer == "again":
        if not learning:
            lapses += 1
            ease = max(MIN_EASE, ease - 0.2)
        interval, minutes = 0, AGAIN_MINUTES
    elif answer == "hard":
        if learning:
            minutes = HARD_MINUTES
        else:
            ease = max(MIN_EASE, ease - 0.15)
            interval = max(interval + 1, round(interval * 1.2))
    elif answer == "good":
        if learning:
            interval = 1
        else:
            interval = max(interval + 1, round(interval * ease)) if interval > 1 else 3
    elif answer == "easy":
        if learning:
            interval = 4
        else:
            good = max(interval + 1, round(interval * ease)) if interval > 1 else 3
            interval = max(good + 1, round(interval * ease * 1.3))
        ease += 0.15
    else:
        raise ValueError(answer)

    interval = min(interval, MAX_INTERVAL_DAYS)
    wait = timedelta(minutes=minutes) if interval == 0 else timedelta(days=interval)
    return {
        "ease": round(ease, 2), "interval_days": interval, "reps": reps + 1, "lapses": lapses,
        "due_at": now + wait, "last_reviewed_at": now,
        "first_reviewed_at": card.first_reviewed_at or now,
    }


def previews(card, now):
    """Seconds until the card comes back for each answer, for the answer buttons."""
    return {answer: int((next_state(card, answer, now)["due_at"] - now).total_seconds()) for answer in ANSWERS}
