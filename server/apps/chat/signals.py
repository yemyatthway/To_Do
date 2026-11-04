from django.db.models.signals import pre_delete
from django.dispatch import receiver

from apps.users.models import User

from .models import GroupMember
from .services import keep_an_admin


@receiver(pre_delete, sender=User)
def leave_groups(sender, instance, **kwargs):
    """An account is being erased for good: its groups keep an admin, and one left empty goes too."""
    for member in GroupMember.objects.filter(user=instance).select_related("conversation"):
        conversation = member.conversation
        member.delete()
        if conversation.members.exists():
            keep_an_admin(conversation)
        else:
            conversation.delete()
