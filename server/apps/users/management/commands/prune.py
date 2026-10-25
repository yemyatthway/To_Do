from django.core.management.base import BaseCommand

from apps.users.cleanup import prune


class Command(BaseCommand):
    help = "Delete expired codes, tokens, old auth events and finished shares. Run daily."

    def handle(self, *args, **options):
        for name, count in prune().items():
            self.stdout.write(f"{name}: {count} deleted")
