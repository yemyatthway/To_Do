from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView


from . import services
from .models import Friendship, Share, SharedTask


def person(user, me=None, friendship=None):
    data = {"id": user.pk, "full_name": user.full_name, "email": services.mask_email(user.email)}
    if me is not None:
        data["relationship"], data["friendship_id"] = services.relationship(me, friendship)
    return data


class SharedTaskSerializer(serializers.ModelSerializer):
    class Meta:
        model = SharedTask
        fields = ["id", "title", "notes", "due_at", "category", "priority", "added"]


class ShareSerializer(serializers.ModelSerializer):
    tasks = SharedTaskSerializer(many=True, read_only=True)
    sender = serializers.SerializerMethodField()
    recipient = serializers.SerializerMethodField()

    class Meta:
        model = Share
        fields = ["id", "sender", "recipient", "message", "status", "created_at", "tasks"]

    def get_sender(self, share):
        return person(share.sender)

    def get_recipient(self, share):
        return person(share.recipient)


class UserSearchApi(APIView):
    """?q=<name, or an exact email>. Needs 2+ characters; at most 20 results."""

    throttle_scope = "user_search"

    def get(self, request):
        me = request.user
        users = services.search_users(me=me, query=request.query_params.get("q", ""))
        by_other = services.friendships_by_other(me)
        return Response([person(u, me, by_other.get(u.pk)) for u in users])


class FriendsApi(APIView):
    def get(self, request):
        me = request.user
        rows = Friendship.objects.filter(pk__in=[f.pk for f in services.friendships_by_other(me).values()]).select_related(
            "requester", "addressee"
        )
        friends, incoming, outgoing = [], [], []
        for f in rows:
            entry = person(f.other(me), me, f)
            {"friends": friends, "incoming": incoming, "outgoing": outgoing}[entry["relationship"]].append(entry)
        key = lambda p: (p["full_name"] or p["email"]).lower()  # noqa: E731
        return Response({"friends": sorted(friends, key=key), "incoming": sorted(incoming, key=key), "outgoing": sorted(outgoing, key=key)})


class FriendRequestApi(APIView):
    """POST {user_id}: ask to be friends (or accept, if they already asked you)."""

    def post(self, request):
        user_id = request.data.get("user_id")
        if not isinstance(user_id, int):
            return Response({"user_id": ["This field is required."]}, status=status.HTTP_400_BAD_REQUEST)
        friendship = services.send_request(me=request.user, user_id=user_id)
        return Response(person(friendship.other(request.user), request.user, friendship), status=status.HTTP_201_CREATED)


class FriendAcceptApi(APIView):
    def post(self, request, friendship_id):
        friendship = services.accept_request(me=request.user, friendship_id=friendship_id)
        return Response(person(friendship.other(request.user), request.user, friendship))


class FriendshipDeleteApi(APIView):
    """Decline, cancel or unfriend."""

    def delete(self, request, friendship_id):
        services.remove_friendship(me=request.user, friendship_id=friendship_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ShareCreateSerializer(serializers.Serializer):
    recipient_id = serializers.IntegerField()
    task_ids = serializers.ListField(child=serializers.IntegerField(), min_length=1, max_length=services.MAX_TASKS_PER_SHARE)
    message = serializers.CharField(max_length=280, required=False, allow_blank=True, default="")


class SharesApi(APIView):
    """GET: what friends sent you (new first). POST: send copies of your tasks to a friend."""

    def get(self, request):
        shares = (
            Share.objects.filter(recipient=request.user, sender__is_active=True)
            .exclude(status=Share.Status.DISMISSED)
            .select_related("sender", "recipient")
            .prefetch_related("tasks")[:50]
        )
        return Response(ShareSerializer(shares, many=True).data)

    def post(self, request):
        serializer = ShareCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        share = services.share_tasks(me=request.user, **serializer.validated_data)
        return Response(ShareSerializer(share).data, status=status.HTTP_201_CREATED)


class ShareAddApi(APIView):
    """POST {item_ids?}: copy all (or some) of the shared tasks into your list."""

    def post(self, request, share_id):
        item_ids = request.data.get("item_ids")
        share, created, moved, clashes = services.add_shared(
            me=request.user, share_id=share_id, item_ids=set(item_ids) if isinstance(item_ids, list) else None
        )
        share = Share.objects.select_related("sender", "recipient").prefetch_related("tasks").get(pk=share.pk)
        return Response(
            {
                "share": ShareSerializer(share).data,
                "added": len(created),
                "task_ids": [t.pk for t in created],
                "moved_to_anytime": moved,
                "clashes": clashes,
            }
        )


class ShareDismissApi(APIView):
    def post(self, request, share_id):
        services.dismiss_share(me=request.user, share_id=share_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class SocialSummaryApi(APIView):
    """Badge counts: friend requests waiting for you, and new shares."""

    def get(self, request):
        me = request.user
        return Response(
            {
                "incoming_requests": Friendship.objects.filter(addressee=me, status=Friendship.Status.PENDING, requester__is_active=True).count(),
                "new_shares": Share.objects.filter(recipient=me, status=Share.Status.NEW, sender__is_active=True).count(),
            }
        )


