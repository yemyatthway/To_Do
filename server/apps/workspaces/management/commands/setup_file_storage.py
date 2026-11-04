import requests
from django.conf import settings
from django.core.management.base import BaseCommand

from apps.workspaces import storage


class Command(BaseCommand):
    help = "Creates the private Supabase bucket for workspace files, if it isn't there. Safe to run on every deploy."

    def handle(self, *args, **options):
        if settings.FILE_STORAGE != "supabase" or not storage.enabled():
            self.stdout.write("File storage isn't set up yet: skipping.")
            return
        bucket = settings.SUPABASE_BUCKET
        body = {"id": bucket, "name": bucket, "public": False, "file_size_limit": settings.FILE_MAX_BYTES}
        try:
            url = f"{storage._base()}/bucket"
            found = requests.get(f"{url}/{bucket}", headers=storage._headers(), timeout=storage.TIMEOUT)
            if found.ok:
                response = requests.put(f"{url}/{bucket}", json=body, headers=storage._headers(), timeout=storage.TIMEOUT)
            else:
                response = requests.post(url, json=body, headers=storage._headers(), timeout=storage.TIMEOUT)
            response.raise_for_status()
        except requests.RequestException as error:
            # Don't stop the deploy for this: adding files shows a clear error until it's fixed.
            self.stderr.write(f"Couldn't set up the file bucket: {error}")
            return
        self.stdout.write(f"File bucket {bucket} is ready.")
