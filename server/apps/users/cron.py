import hmac

from django.conf import settings
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .cleanup import prune


class PruneView(APIView):
    """Daily clean-up, called by an external scheduler with the X-Cron-Secret header."""

    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        secret = settings.CRON_SECRET
        if not secret or not hmac.compare_digest(request.headers.get("X-Cron-Secret", ""), secret):
            return Response({"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN)
        return Response(prune())
