import base64
import hashlib
import hmac
from datetime import timedelta
from unittest import mock

from django.db import connection
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.notifications.models import PushSubscription
from apps.social.models import Friendship
from apps.users.models import User

from . import services
from .models import Conversation, Message, MessageReaction, ScheduledMessage

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

    def send(self, chat, text, user=None):
        self.client.force_authenticate(user or self.mia)
        return self.client.post(f"/api/chat/{chat['id']}/messages/", {"text": text}, format="json").data

    def texts(self, chat, user):
        self.client.force_authenticate(user)
        return [m["text"] for m in self.client.get(f"/api/chat/{chat['id']}/messages/").data["messages"]]

    def test_sending_a_message_twice_posts_and_notifies_once(self, send_push):
        chat = self.open()
        body = {"text": "Only once", "client_id": "6f1c2a7e-5b3d-4c8e-9a10-1234567890ab"}
        first = self.client.post(f"/api/chat/{chat['id']}/messages/", body, format="json")
        again = self.client.post(f"/api/chat/{chat['id']}/messages/", body, format="json")
        self.assertEqual(first.data["id"], again.data["id"])
        self.assertEqual(first.data["client_id"], body["client_id"])
        self.assertEqual(Message.objects.count(), 1)
        self.assertEqual(send_push.call_count, 1)

    def test_edit_your_own_message_within_a_day(self, send_push):
        chat = self.open()
        mine = self.send(chat, "See you at 7")
        url = f"/api/chat/{chat['id']}/messages/{mine['id']}/"
        edited = self.client.patch(url, {"text": "See you at 8"}, format="json")
        self.assertEqual((edited.data["text"], edited.data["edited"]), ("See you at 8", True))
        self.assertEqual(self.texts(chat, self.aung), ["See you at 8"])
        # Not someone else's, and not after a day.
        theirs = self.send(chat, "ok", user=self.aung)
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.patch(f"/api/chat/{chat['id']}/messages/{theirs['id']}/", {"text": "hacked"}, format="json").status_code, 404)
        Message.objects.filter(pk=mine["id"]).update(created_at=timezone.now() - timezone.timedelta(hours=25))
        self.assertEqual(self.client.patch(url, {"text": "too late"}, format="json").status_code, 400)

    def test_delete_for_me_hides_it_only_on_my_side(self, send_push):
        chat = self.open()
        theirs = self.send(chat, "a secret", user=self.aung)
        self.send(chat, "unread one", user=self.aung)
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.delete(f"/api/chat/{chat['id']}/messages/{theirs['id']}/?for=me").status_code, 204)
        self.assertEqual(self.texts(chat, self.mia), ["unread one"])
        self.assertEqual(self.client.get("/api/chat/").data["unread"], 1)  # the hidden one no longer counts
        self.assertEqual(self.texts(chat, self.aung), ["a secret", "unread one"])  # Aung still has both
        # It's still Aung's message: it isn't wiped for him.
        self.assertIsNone(Message.objects.get(pk=theirs["id"]).deleted_at)

    def test_clear_chat_empties_it_for_me_until_something_new_arrives(self, send_push):
        chat = self.open()
        self.send(chat, "one")
        self.send(chat, "two", user=self.aung)
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.post(f"/api/chat/{chat['id']}/clear/").status_code, 204)
        self.assertEqual(self.texts(chat, self.mia), [])
        self.assertEqual(self.client.get("/api/chat/").data["chats"], [])
        self.assertEqual(self.texts(chat, self.aung), ["one", "two"])
        self.send(chat, "three", user=self.aung)
        self.assertEqual(self.texts(chat, self.mia), ["three"])
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.get("/api/chat/").data["chats"][0]["last_message"]["text"], "three")


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


@override_settings(PUSH_SEND_ASYNC=False, LIVE_SEND_ASYNC=False)
@mock.patch("apps.social.services.send_push")
class RepliesAndReactionsTests(APITestCase):
    def setUp(self):
        now = timezone.now()
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=now, reminders_enabled=True)
        self.aung = User.objects.create_user("aung@example.com", PASSWORD, full_name="Ko Aung", email_verified_at=now, reminders_enabled=True)
        self.sara = User.objects.create_user("sara@example.com", PASSWORD, full_name="Sara", email_verified_at=now)
        Friendship.objects.create(requester=self.mia, addressee=self.aung, status=Friendship.Status.ACCEPTED)
        Friendship.objects.create(requester=self.mia, addressee=self.sara, status=Friendship.Status.ACCEPTED)
        from apps.notifications.models import PushSubscription

        PushSubscription.objects.create(user=self.aung, endpoint="https://push.example.com/aung", p256dh="k", auth="a")
        self.client.force_authenticate(self.mia)
        self.chat = self.client.post(f"/api/chat/with/{self.aung.id}/").data["id"]
        self.other_chat = self.client.post(f"/api/chat/with/{self.sara.id}/").data["id"]

    def send(self, text="Hello", **more):
        return self.client.post(f"/api/chat/{self.chat}/messages/", {"text": text, **more}, format="json")

    def react(self, message, emoji="❤️"):
        return self.client.post(f"/api/chat/{self.chat}/messages/{message}/react/", {"emoji": emoji}, format="json")

    def test_a_reply_carries_what_it_answers(self, send_push):
        first = self.send("Can you check this?").data
        self.client.force_authenticate(self.aung)
        reply = self.send("On it", reply_to=first["id"]).data
        self.assertEqual(reply["reply"], {"id": first["id"], "sender": self.mia.id, "text": "Can you check this?", "deleted": False})
        listed = self.client.get(f"/api/chat/{self.chat}/messages/").data["messages"][-1]
        self.assertEqual(listed["reply"]["text"], "Can you check this?")
        self.assertIsNone(self.send("Plain").data["reply"])

    def test_a_reply_to_something_from_another_chat_is_just_a_message(self, send_push):
        elsewhere = self.client.post(f"/api/chat/{self.other_chat}/messages/", {"text": "Secret"}, format="json").data
        response = self.send("Hi", reply_to=elsewhere["id"])
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.data["reply"])
        self.assertIsNone(self.send("Hi", reply_to=999999).data["reply"])

    def test_a_deleted_original_never_shows_its_words(self, send_push):
        first = self.send("Private").data
        reply = self.send("About that", reply_to=first["id"]).data
        self.client.delete(f"/api/chat/{self.chat}/messages/{first['id']}/")
        listed = next(m for m in self.client.get(f"/api/chat/{self.chat}/messages/").data["messages"] if m["id"] == reply["id"])
        self.assertEqual(listed["reply"], {"id": first["id"], "sender": self.mia.id, "text": "", "deleted": True})

    def test_a_reply_outlives_an_erased_original(self, send_push):
        first = self.send("Old").data
        reply = self.send("New", reply_to=first["id"]).data
        Message.objects.filter(pk=first["id"]).delete()
        self.assertIsNone(next(m for m in self.client.get(f"/api/chat/{self.chat}/messages/").data["messages"] if m["id"] == reply["id"])["reply"])

    def test_reacting_swaps_and_takes_back(self, send_push):
        message = self.send().data["id"]
        self.assertEqual(self.react(message).data["reactions"], [{"user": self.mia.id, "emoji": "❤️"}])
        self.assertEqual(self.react(message, "🔥").data["reactions"], [{"user": self.mia.id, "emoji": "🔥"}])
        self.assertEqual(MessageReaction.objects.count(), 1)
        self.client.force_authenticate(self.aung)
        both = self.react(message, "😮").data["reactions"]
        self.assertEqual(sorted(r["emoji"] for r in both), ["🔥", "😮"])
        listed = self.client.get(f"/api/chat/{self.chat}/messages/").data["messages"][-1]["reactions"]
        self.assertEqual(len(listed), 2)
        gone = self.client.delete(f"/api/chat/{self.chat}/messages/{message}/react/").data["reactions"]
        self.assertEqual(gone, [{"user": self.mia.id, "emoji": "🔥"}])

    def test_any_keyboard_emoji_works(self, send_push):
        message = self.send().data["id"]
        for emoji in ("😀", "❤️", "👍🏽", "👨‍👩‍👧‍👦", "🧑🏻‍❤️‍💋‍🧑🏼", "🤦🏽‍♂️", "🇲🇲", "1️⃣", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "🫶"):
            response = self.react(message, emoji)
            self.assertEqual(response.status_code, 200, emoji)
            self.assertEqual(response.data["reactions"][0]["emoji"], emoji)

    def test_a_reaction_is_one_emoji_and_only_people_in_the_chat(self, send_push):
        message = self.send().data["id"]
        for bad in ("nope", "", 5, None, "😀😀", "😀 ", "a😀", "<b>", "1", "🇲", "😀" * 40):
            self.assertEqual(self.react(message, bad).status_code, 400, bad)
        self.client.force_authenticate(self.sara)
        self.assertEqual(self.react(message).status_code, 404)
        self.client.force_authenticate(self.mia)
        self.assertEqual(self.client.post(f"/api/chat/{self.other_chat}/messages/{message}/react/", {"emoji": "❤️"}, format="json").status_code, 404)

    def test_a_deleted_message_takes_no_reactions_and_shows_none(self, send_push):
        message = self.send().data["id"]
        self.react(message)
        self.client.delete(f"/api/chat/{self.chat}/messages/{message}/")
        self.assertEqual(self.react(message).status_code, 404)
        self.assertEqual(self.client.get(f"/api/chat/{self.chat}/messages/").data["messages"][-1]["reactions"], [])

    def test_a_message_you_hid_takes_no_reaction_from_you(self, send_push):
        message = self.send().data["id"]
        self.client.delete(f"/api/chat/{self.chat}/messages/{message}/?for=me")
        self.assertEqual(self.react(message).status_code, 404)

    def test_former_friends_cannot_react_but_can_take_it_back(self, send_push):
        message = self.send().data["id"]
        self.react(message)
        Friendship.objects.filter(requester=self.mia, addressee=self.aung).delete()
        self.assertEqual(self.react(message, "🔥").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/chat/{self.chat}/messages/{message}/react/").status_code, 200)

    def test_reactions_go_live_to_the_chat(self, send_push):
        message = self.send().data["id"]
        with mock.patch("apps.chat.services.ably.to_chat") as to_chat:
            self.react(message)
        to_chat.assert_called_once_with(self.chat, "reacted", {"id": message, "reactions": [{"user": self.mia.id, "emoji": "❤️"}]})

    def test_reacting_to_their_message_tells_them_when_they_are_away(self, send_push):
        self.client.force_authenticate(self.aung)
        theirs = self.send().data["id"]
        self.client.force_authenticate(self.mia)
        mine = self.send().data["id"]
        send_push.reset_mock()
        self.client.force_authenticate(self.aung)
        self.react(mine)
        self.assertEqual(send_push.call_count, 0)  # Mia has no devices
        self.client.force_authenticate(self.mia)
        self.react(theirs)
        self.assertEqual(send_push.call_count, 1)
        self.assertIn("Reacted ❤️ to your message", send_push.call_args.args)


@override_settings(PUSH_SEND_ASYNC=False, LIVE_SEND_ASYNC=False)
@mock.patch("apps.social.services.send_push")
class ScheduledMessageTests(APITestCase):
    def setUp(self):
        now = timezone.now()
        self.mia = User.objects.create_user("mia@example.com", PASSWORD, full_name="Mia", email_verified_at=now, reminders_enabled=True)
        self.aung = User.objects.create_user("aung@example.com", PASSWORD, full_name="Ko Aung", email_verified_at=now, reminders_enabled=True)
        self.sara = User.objects.create_user("sara@example.com", PASSWORD, full_name="Sara", email_verified_at=now)
        Friendship.objects.create(requester=self.mia, addressee=self.aung, status=Friendship.Status.ACCEPTED)
        self.client.force_authenticate(self.mia)
        PushSubscription.objects.create(user=self.aung, endpoint="https://push.example.com/aung", p256dh="k", auth="a")
        self.chat = self.client.post(f"/api/chat/with/{self.aung.id}/").data["id"]
        self.url = f"/api/chat/{self.chat}/scheduled/"

    def later(self, **delta):
        return (timezone.now() + timedelta(**(delta or {"hours": 1}))).isoformat()

    def add(self, text="Happy birthday", **more):
        return self.client.post(self.url, {"text": text, "send_at": self.later(), **more}, format="json")

    def messages(self):
        return self.client.get(f"/api/chat/{self.chat}/messages/").data["messages"]

    def test_it_waits_for_its_time_then_sends_like_a_normal_message(self, send_push):
        made = self.add()
        self.assertEqual(made.status_code, 201)
        self.assertEqual(made.data["status"], "pending")
        self.assertEqual(self.messages(), [])
        self.assertEqual(services.send_due_scheduled(), 0)
        self.assertEqual(services.send_due_scheduled(timezone.now() + timedelta(hours=2)), 1)
        message = self.messages()[0]
        self.assertEqual((message["text"], message["sender"]), ("Happy birthday", self.mia.id))
        self.assertEqual(self.client.get(self.url).data, [])
        self.assertEqual(send_push.call_count, 1)
        self.assertEqual(services.send_due_scheduled(timezone.now() + timedelta(hours=2)), 0)

    def test_the_words_are_stored_encrypted(self, send_push):
        self.add("Secret plan")
        self.assertNotIn("Secret plan", ScheduledMessage.objects.get().body)

    def test_the_time_must_make_sense(self, send_push):
        for bad in ("nope", None, 5, "2026-11-04T10:00:00", self.later(hours=-1), self.later(days=400), "2026-13-45T10:00:00Z"):
            self.assertEqual(self.client.post(self.url, {"text": "Hi", "send_at": bad}, format="json").status_code, 400, bad)
        self.assertEqual(self.client.post(self.url, {"text": "  ", "send_at": self.later()}, format="json").status_code, 400)

    def test_only_you_see_or_change_yours(self, send_push):
        item = self.add().data["id"]
        self.client.force_authenticate(self.aung)
        self.assertEqual(self.client.get(self.url).data, [])
        self.assertEqual(self.client.delete(f"{self.url}{item}/").status_code, 404)
        self.assertEqual(self.client.patch(f"{self.url}{item}/", {"text": "Hacked"}, format="json").status_code, 404)
        self.assertEqual(self.client.post(f"{self.url}{item}/").status_code, 404)
        self.client.force_authenticate(self.sara)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.post(self.url, {"text": "x", "send_at": self.later()}, format="json").status_code, 404)

    def test_change_delete_and_send_now(self, send_push):
        item = self.add().data["id"]
        changed = self.client.patch(f"{self.url}{item}/", {"text": "New words", "send_at": self.later(hours=3)}, format="json").data
        self.assertEqual(changed["text"], "New words")
        self.assertEqual(self.client.post(f"{self.url}{item}/").status_code, 201)
        self.assertEqual(self.messages()[0]["text"], "New words")
        self.assertEqual(self.client.get(self.url).data, [])
        other = self.add().data["id"]
        self.assertEqual(self.client.delete(f"{self.url}{other}/").status_code, 204)
        self.assertEqual(self.client.delete(f"{self.url}{other}/").status_code, 404)

    def test_no_longer_friends_means_it_fails_and_you_are_told(self, send_push):
        PushSubscription.objects.create(user=self.mia, endpoint="https://push.example.com/mia", p256dh="k", auth="a")
        self.add()
        Friendship.objects.all().delete()
        self.assertEqual(services.send_due_scheduled(timezone.now() + timedelta(hours=2)), 0)
        item = self.client.get(self.url).data[0]
        self.assertEqual(item["status"], "failed")
        self.assertIn("no longer friends", item["error"])
        self.assertEqual(self.messages(), [])
        self.assertIn("A scheduled message wasn't sent", send_push.call_args.args)
        self.assertEqual(self.add().status_code, 403)

    def test_a_crashed_run_is_retried_without_posting_twice(self, send_push):
        self.add()
        now = timezone.now() + timedelta(hours=2)
        item = ScheduledMessage.objects.get()
        services.send(self.mia, Conversation.objects.get(pk=self.chat), item.text, client_id=item.client_id)
        ScheduledMessage.objects.update(status="sending", claimed_at=now - timedelta(minutes=6))
        self.assertEqual(services.send_due_scheduled(now), 1)
        self.assertEqual(len(self.messages()), 1)
        self.assertFalse(ScheduledMessage.objects.exists())

    def test_one_being_sent_right_now_cannot_be_changed(self, send_push):
        item = self.add().data["id"]
        ScheduledMessage.objects.update(status="sending", claimed_at=timezone.now())
        self.assertEqual(self.client.delete(f"{self.url}{item}/").status_code, 404)
        ScheduledMessage.objects.update(send_at=timezone.now() - timedelta(minutes=1))
        self.assertEqual(services.send_due_scheduled(), 0)

    def test_there_is_a_limit(self, send_push):
        with mock.patch("apps.chat.services.MAX_SCHEDULED", 1):
            self.assertEqual(self.add().status_code, 201)
            self.assertEqual(self.add().status_code, 400)
