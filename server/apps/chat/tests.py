import base64
import hashlib
import hmac
from unittest import mock

from django.db import connection
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.social.models import Friendship
from apps.users.models import User

from .models import Conversation, Message

PASSWORD = "Sunny-Clock-2026"
KEY = "appid.keyname:topsecret"


@override_settings(PUSH_SEND_ASYNC=False, LIVE_SEND_ASYNC=False)
@mock.patch("apps.social.services.send_push")
class ChatTests(APITestCase):
    def setUp(self):
        now = timezone.now()
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=now, reminders_enabled=True)
        self.aung = User.objects.create_user("aung@example.com", PASSWORD, full_name="Ko Aung", email_verified_at=now, reminders_enabled=True)
        self.sara = User.objects.create_user("sara@example.com", PASSWORD, full_name="Sara", email_verified_at=now)
        Friendship.objects.create(requester=self.mia, addressee=self.aung, status=Friendship.Status.ACCEPTED)
        from apps.notifications.models import PushSubscription

        PushSubscription.objects.create(user=self.aung, endpoint="https://push.example.com/aung", p256dh="k", auth="a")
        self.client.force_authenticate(self.mia)

    def open(self, user=None):
        return self.client.post(f"/api/chat/with/{(user or self.aung).id}/").data

    def test_friends_chat_and_messages_are_encrypted_in_the_database(self, send_push):
        chat = self.open()
        sent = self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": "  See you at 7?  "}, format="json")
        self.assertEqual(sent.status_code, 201, sent.data)
        self.assertEqual(sent.data["text"], "See you at 7?")
        with connection.cursor() as cursor:
            cursor.execute("SELECT body FROM chat_message")
            stored = cursor.fetchone()[0]
        self.assertNotIn("See you", stored)  # scrambled at rest
        self.assertEqual(Message.objects.get().text, "See you at 7?")
        self.assertEqual(send_push.call_args.args[1:3], ("Mia", "See you at 7?"))  # Aung isn't in the chat

        self.client.force_authenticate(self.aung)
        listing = self.client.get("/api/chat/").data
        self.assertEqual((listing["unread"], listing["chats"][0]["friend"]["full_name"]), (1, "Mia"))
        page = self.client.get(f"/api/chat/{chat['id']}/messages/").data
        self.assertEqual([(m["text"], m["mine"]) for m in page["messages"]], [("See you at 7?", False)])
        self.client.post(f"/api/chat/{chat['id']}/read/")
        self.assertEqual(self.client.get("/api/chat/").data["unread"], 0)

        self.client.force_authenticate(self.mia)
        self.assertIsNotNone(self.client.get("/api/chat/").data["chats"][0]["friend_read_at"])  # "Seen"

    def test_only_friends_and_only_the_two_of_them(self, send_push):
        self.assertEqual(self.client.post(f"/api/chat/with/{self.sara.id}/").status_code, 403)
        chat = self.open()
        self.assertEqual(self.open()["id"], chat["id"])  # one chat per pair
        self.client.force_authenticate(self.sara)
        self.assertEqual(self.client.get(f"/api/chat/{chat['id']}/messages/").status_code, 404)
        self.assertEqual(self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": "hi"}, format="json").status_code, 404)

        Friendship.objects.all().delete()
        self.client.force_authenticate(self.mia)
        blocked = self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": "still there?"}, format="json")
        self.assertEqual(blocked.status_code, 403)

    def test_validation_paging_and_delete_for_everyone(self, send_push):
        chat = self.open()
        self.assertEqual(self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": "   "}, format="json").status_code, 400)
        self.assertEqual(self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": "x" * 2001}, format="json").status_code, 400)
        ids = [self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": f"m{i}"}, format="json").data["id"] for i in range(55)]
        latest = self.client.get(f"/api/chat/{chat['id']}/messages/").data["messages"]
        self.assertEqual((len(latest), latest[-1]["text"]), (50, "m54"))
        older = self.client.get(f"/api/chat/{chat['id']}/messages/", {"before": latest[0]["id"]}).data["messages"]
        self.assertEqual([m["text"] for m in older], ["m0", "m1", "m2", "m3", "m4"])

        self.client.force_authenticate(self.aung)
        self.assertEqual(self.client.delete(f"/api/chat/{chat['id']}/messages/{ids[0]}/").status_code, 404)  # not his
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.delete(f"/api/chat/{chat['id']}/messages/{ids[0]}/").status_code, 204)
        gone = Message.objects.get(pk=ids[0])
        self.assertEqual((gone.text, gone.deleted_at is not None), ("", True))

    @override_settings(ABLY_API_KEY=KEY)
    @mock.patch("apps.live.ably.requests.get")
    @mock.patch("apps.live.ably.requests.post")
    def test_live_events_go_to_the_chat_and_both_people(self, post, get, send_push):
        post.return_value.status_code = 201
        get.return_value.json.return_value = [{"clientId": str(self.aung.pk)}]  # Aung has the chat open
        chat = self.open()
        self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": "hello"}, format="json")
        channels = [call.args[0].rsplit("/channels/", 1)[1].split("/")[0] for call in post.call_args_list]
        self.assertIn(f"chat%3A{chat['id']}", channels)
        self.assertIn(f"user%3A{self.aung.pk}", channels)
        send_push.assert_not_called()  # he's looking at it, so no push


@override_settings(ABLY_API_KEY=KEY)
class LiveTokenTests(APITestCase):
    def test_pass_only_covers_your_own_channels_and_is_signed(self):
        now = timezone.now()
        mia = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=now)
        aung = User.objects.create_user("aung@example.com", PASSWORD, email_verified_at=now)
        sara = User.objects.create_user("sara@example.com", PASSWORD, email_verified_at=now)
        Friendship.objects.create(requester=mia, addressee=aung, status=Friendship.Status.ACCEPTED)
        conversation = Conversation.objects.create(user_a=mia, user_b=aung)
        self.client.force_authenticate(mia)
        data = self.client.get("/api/live/token/").data
        request = data["token_request"]
        import json

        capability = json.loads(request["capability"])
        self.assertEqual(capability[f"user:{mia.pk}"], ["subscribe"])
        self.assertEqual(capability[f"online:{mia.pk}"], ["presence"])
        # Friends can see Aung is online, but not read Aung's own events or pretend to be Aung.
        self.assertEqual(capability[f"online:{aung.pk}"], ["subscribe"])
        self.assertNotIn(f"user:{aung.pk}", capability)
        self.assertIn(f"chat:{conversation.pk}", capability)
        self.assertNotIn(f"online:{sara.pk}", capability)
        self.assertNotIn("admin", capability)
        signed = "".join(f"{request[k]}\n" for k in ("keyName", "ttl", "capability", "clientId", "timestamp", "nonce"))
        expected = base64.b64encode(hmac.new(b"topsecret", signed.encode(), hashlib.sha256).digest()).decode()
        self.assertEqual((request["keyName"], request["clientId"], request["mac"]), ("appid.keyname", str(mia.pk), expected))

    @override_settings(ABLY_API_KEY="")
    def test_off_without_a_key(self):
        user = User.objects.create_user("mia@example.com", PASSWORD, email_verified_at=timezone.now())
        self.client.force_authenticate(user)
        self.assertEqual(self.client.get("/api/live/token/").data, {"enabled": False})
