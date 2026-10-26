from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.social.views import person

from . import services
from .models import Conversation


class SendSerializer(serializers.Serializer):
    text = serializers.CharField(max_length=services.MAX_LENGTH, allow_blank=True, trim_whitespace=False)


def conversation_data(conversation, me):
    other = conversation.other(me)
    last = conversation.messages.order_by("-created_at", "-id").select_related("sender").first()
    other_read = conversation.read_at(other)
    return {
        "id": conversation.pk,
        "friend": person(other),
        "last_message": services.message_data(last, me) if last else None,
        "last_message_at": conversation.last_message_at,
        "unread": services.unread_count(me, conversation),
        # For "Seen" under your last message.
        "friend_read_at": other_read.isoformat() if other_read else None,
    }


class ChatListApi(APIView):
    """GET: your chats, newest first, with the last message and unread counts."""

    throttle_scope = "chat"

    def get(self, request):
        me = request.user
        conversations = (
            Conversation.involving(me)
            .filter(last_message_at__isnull=False, user_a__is_active=True, user_b__is_active=True)
            .select_related("user_a", "user_b")
            .order_by("-last_message_at")[:100]
        )
        items = [conversation_data(c, me) for c in conversations]
        return Response({"chats": items, "unread": sum(i["unread"] for i in items)})


class ChatOpenApi(APIView):
    """POST: the chat with this friend (created the first time)."""

    throttle_scope = "chat"

    def post(self, request, user_id):
        conversation = services.open_with(request.user, user_id)
        return Response(conversation_data(conversation, request.user))


class MessagesApi(APIView):
    """GET ?before=<id>: the 50 messages before that one (or the latest). POST {text}: send."""

    throttle_scope = "chat"

    def get(self, request, conversation_id):
        me = request.user
        conversation = services.conversation_for(me, conversation_id)
        before = request.query_params.get("before")
        page = services.history(me, conversation, int(before) if before and before.isdigit() else None)
        return Response({"chat": conversation_data(conversation, me), "messages": [services.message_data(m, me) for m in page]})

    def post(self, request, conversation_id):
        conversation = services.conversation_for(request.user, conversation_id)
        serializer = SendSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        message = services.send(request.user, conversation, serializer.validated_data["text"])
        return Response(services.message_data(message, request.user), status=status.HTTP_201_CREATED)


class ReadApi(APIView):
    def post(self, request, conversation_id):
        conversation = services.conversation_for(request.user, conversation_id)
        return Response({"read_at": services.mark_read(request.user, conversation)})


class MessageDeleteApi(APIView):
    def delete(self, request, conversation_id, message_id):
        conversation = services.conversation_for(request.user, conversation_id)
        services.delete_message(request.user, conversation, message_id)
        return Response(status=status.HTTP_204_NO_CONTENT)
