from rest_framework.response import Response
from rest_framework.views import APIView

from apps.chat.models import Conversation
from apps.social.services import friendships_by_other

from . import ably


class LiveTokenApi(APIView):
    """GET: a pass for this browser's live connection, limited to its own channels:
    its user channel, its "online" channel (presence only), friends' online channels (to see who's
    online; nothing else is ever sent there), its chats, and the admin channel for staff. {"enabled": false} when live updates aren't configured."""

    def get(self, request):
        me = request.user
        if not ably.enabled():
            return Response({"enabled": False})
        capability = {f"user:{me.pk}": ["subscribe"], f"online:{me.pk}": ["presence"]}
        for friend_id, friendship in friendships_by_other(me).items():
            if friendship.status == friendship.Status.ACCEPTED:
                # Seeing who's present needs "subscribe"; only the owner can enter.
                capability[f"online:{friend_id}"] = ["subscribe"]
        for conversation_id in Conversation.involving(me).values_list("pk", flat=True):
            capability[f"chat:{conversation_id}"] = ["subscribe", "publish", "presence"]
        if me.is_staff:
            capability["admin"] = ["subscribe"]
        return Response({"enabled": True, "client_id": str(me.pk), "token_request": ably.token_request(me.pk, capability)})
