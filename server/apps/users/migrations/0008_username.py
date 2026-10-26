import re
import unicodedata

from django.db import migrations, models

RESERVED = {
    "admin", "administrator", "api", "app", "help", "me", "mod", "moderator", "null", "official",
    "root", "staff", "support", "system", "todo", "todoclock", "undefined", "you",
}


def _slug(text):
    ascii_text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", ascii_text.lower())


def give_usernames(apps, schema_editor):
    """Every existing account gets one from its name (or email), e.g. ryenkai, ryenkai2. They're
    asked to keep or change it the next time they open the app (username_confirmed_at stays empty)."""
    User = apps.get_model("users", "User")
    used = set()
    for user in User.objects.order_by("date_joined", "pk"):
        base = (_slug(user.full_name) or _slug(user.email.partition("@")[0]) or "user")[:20]
        if len(base) < 3:
            base = (base + "user")[:20]
        if base in RESERVED:
            base += "1"
        candidate, number = base, 1
        while candidate in used:
            number += 1
            candidate = base[: 20 - len(str(number))] + str(number)
        used.add(candidate)
        user.username = candidate
        user.save(update_fields=["username"])


class Migration(migrations.Migration):
    dependencies = [("users", "0007_backfill_last_login")]

    operations = [
        migrations.AddField(model_name="user", name="username", field=models.CharField(max_length=20, null=True)),
        migrations.AddField(model_name="user", name="username_confirmed_at", field=models.DateTimeField(blank=True, null=True)),
        migrations.RunPython(give_usernames, migrations.RunPython.noop),
    ]
