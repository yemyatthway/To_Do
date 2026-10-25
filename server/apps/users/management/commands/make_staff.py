from django.core.management.base import BaseCommand, CommandError

from apps.users.models import User


class Command(BaseCommand):
    help = "Give an existing account the Admin dashboard (is_staff). Usage: manage.py make_staff you@example.com"

    def add_arguments(self, parser):
        parser.add_argument("email")
        parser.add_argument("--remove", action="store_true", help="Take admin rights away instead.")

    def handle(self, *args, email, remove, **options):
        user = User.objects.filter(email__iexact=email.strip()).first()
        if user is None:
            raise CommandError(f"No account with the email {email}. Sign up in the app first.")
        user.is_staff = not remove
        user.save(update_fields=["is_staff"])
        self.stdout.write(f"{user.email} is {'no longer' if remove else 'now'} an admin.")
