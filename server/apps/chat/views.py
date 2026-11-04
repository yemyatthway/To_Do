from django.db.models import Q
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.social.views import person

from . import services
from .models import Conversation


class SendSerializer(serializers.Serializer):
    text = serializers.CharField(max_length=services.MAX_LENGTH, allow_blank=True, trim_whitespace=False)
    client_id = serializers.UUIDField(required=False, allow_null=True)
    reply_to = serializers.IntegerField(required=False, allow_null=True)


def member_data(member):
    return {**person(member.user), "is_admin": member.is_admin, "read_at": member.read_at.isoformat() if member.read_at else None}


def conversation_data(conversation, me):
    if conversation.is_group:
        last = services.visible(me, conversation).order_by("-created_at", "-id").select_related("sender").first()
        mine = conversation.member(me)
        return {
            "id": conversation.pk,
            "is_group": True,
            "name": conversation.name,
            # So the screens that show one person can show the group the same way.
            "friend": {"id": 0, "full_name": conversation.title_for(me), "username": "", "email": ""},
            # A deleted account disappears from the group, but comes back if it's restored.
            "members": [member_data(m) for m in conversation.members.all() if m.user.is_active],
            "am_admin": bool(mine and mine.is_admin),
            "last_message": services.message_data(last, me) if last else None,
            "last_message_at": conversation.last_message_at,
            "unread": services.unread_count(me, conversation),
            "friend_read_at": None,
        }
    other = conversation.other(me)
    other_read = conversation.read_at(other)
    last = services.visible(me, conversation).order_by("-created_at", "-id").select_related("sender").first()
    return {
        "id": conversation.pk,
        "is_group": False,
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
            .filter(Q(is_group=True) | Q(user_a__is_active=True, user_b__is_active=True), last_message_at__isnull=False)
            .select_related("user_a", "user_b")
            .prefetch_related("members__user")
            .order_by("-last_message_at")[:100]
        )
        # A chat you cleared stays out of the list until something new arrives.
        items = [data for c in conversations if (data := conversation_data(c, me))["last_message"]]
        return Response({"chats": items, "unread": sum(i["unread"] for i in items)})


class ChatOpenApi(APIView):
    """POST: the chat with this friend (created the first time)."""

    throttle_scope = "chat"

    def post(self, request, user_id):
        conversation = services.open_with(request.user, user_id)
        return Response(conversation_data(conversation, request.user))


class GroupsApi(APIView):
    """POST {name?, members: [user ids]}: make a group with some of your friends."""

    throttle_scope = "chat"

    def post(self, request):
        conversation = services.create_group(request.user, request.data.get("name"), request.data.get("members"))
        return Response(conversation_data(conversation, request.user), status=status.HTTP_201_CREATED)


class GroupApi(APIView):
    """PATCH {name}: rename it (admins). POST {members: [user ids]}: add friends (admins)."""

    throttle_scope = "chat"

    def patch(self, request, conversation_id):
        conversation = services.conversation_for(request.user, conversation_id)
        services.rename_group(request.user, conversation, request.data.get("name"))
        return Response(conversation_data(services.conversation_for(request.user, conversation_id), request.user))

    def post(self, request, conversation_id):
        conversation = services.conversation_for(request.user, conversation_id)
        return Response(conversation_data(services.add_members(request.user, conversation, request.data.get("members")), request.user))


class GroupMemberApi(APIView):
    """DELETE: take this person out (admins), or leave, if it's you."""

    throttle_scope = "chat"

    def delete(self, request, conversation_id, user_id):
        services.remove_member(request.user, services.conversation_for(request.user, conversation_id), user_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


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
        data = serializer.validated_data
        message = services.send(request.user, conversation, data["text"], client_id=data.get("client_id"), reply_to=data.get("reply_to"))
        return Response(services.message_data(message, request.user), status=status.HTTP_201_CREATED)


class ReadApi(APIView):
    def post(self, request, conversation_id):
        conversation = services.conversation_for(request.user, conversation_id)
        return Response({"read_at": services.mark_read(request.user, conversation)})


class MessageApi(APIView):
    """PATCH {text}: edit your message. DELETE: delete it for everyone; ?for=me hides any message
    just for you."""

    throttle_scope = "chat"

    def patch(self, request, conversation_id, message_id):
        conversation = services.conversation_for(request.user, conversation_id)
        serializer = SendSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        message = services.edit_message(request.user, conversation, message_id, serializer.validated_data["text"])
        return Response(services.message_data(message, request.user))

    def delete(self, request, conversation_id, message_id):
        conversation = services.conversation_for(request.user, conversation_id)
        if request.query_params.get("for") == "me":
            services.hide_message(request.user, conversation, message_id)
        else:
            services.delete_message(request.user, conversation, message_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ReactApi(APIView):
    """POST {emoji}: your reaction to this message (replaces any you gave). DELETE: take it back."""

    throttle_scope = "chat"

    def post(self, request, conversation_id, message_id):
        conversation = services.conversation_for(request.user, conversation_id)
        emoji = request.data.get("emoji")
        if not isinstance(emoji, str):
            emoji = ""
        return Response({"reactions": services.react(request.user, conversation, message_id, emoji)})

    def delete(self, request, conversation_id, message_id):
        conversation = services.conversation_for(request.user, conversation_id)
        return Response({"reactions": services.react(request.user, conversation, message_id, None)})


class ClearApi(APIView):
    """POST: clear this chat on your side only."""

    def post(self, request, conversation_id):
        services.clear_chat(request.user, services.conversation_for(request.user, conversation_id))
        return Response(status=status.HTTP_204_NO_CONTENT)


def scheduled_data(item):
    return {"id": item.pk, "text": item.text, "send_at": item.send_at, "status": item.status, "error": item.error}


class ScheduledApi(APIView):
    """GET: your messages waiting to send in this chat. POST {text, send_at}: add one."""

    throttle_scope = "chat"

    def get(self, request, conversation_id):
        conversation = services.conversation_for(request.user, conversation_id)
        return Response([scheduled_data(i) for i in services.scheduled_of(request.user, conversation)])

    def post(self, request, conversation_id):
        conversation = services.conversation_for(request.user, conversation_id)
        item = services.schedule(request.user, conversation, request.data.get("text"), request.data.get("send_at"))
        return Response(scheduled_data(item), status=status.HTTP_201_CREATED)


class ScheduledOneApi(APIView):
    """PATCH {text?, send_at?}: change it. POST: send it now. DELETE: drop it."""

    throttle_scope = "chat"

    def patch(self, request, conversation_id, item_id):
        conversation = services.conversation_for(request.user, conversation_id)
        return Response(scheduled_data(services.update_scheduled(request.user, conversation, item_id, request.data.get("text"), request.data.get("send_at"))))

    def post(self, request, conversation_id, item_id):
        conversation = services.conversation_for(request.user, conversation_id)
        return Response(services.message_data(services.send_scheduled_now(request.user, conversation, item_id), request.user), status=status.HTTP_201_CREATED)

    def delete(self, request, conversation_id, item_id):
        services.delete_scheduled(request.user, services.conversation_for(request.user, conversation_id), item_id)
        return Response(status=status.HTTP_204_NO_CONTENT)
