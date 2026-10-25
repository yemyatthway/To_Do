import time

from django.core.management.base import BaseCommand

from apps.notifications.reminders import send_due_reminders


class Command(BaseCommand):
    help = "Send push reminders for tasks that are coming up. Use --loop for local development."

    def add_arguments(self, parser):
        parser.add_argument("--loop", action="store_true", help="Keep running and check every --every seconds.")
        parser.add_argument("--every", type=int, default=30)

    def handle(self, *args, loop, every, **options):
        while True:
            sent = send_due_reminders()
            if sent or not loop:
                self.stdout.write(f"Sent {sent} reminder(s).")
            if not loop:
                return
            time.sleep(every)
