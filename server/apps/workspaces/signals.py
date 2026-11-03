from django.db.models.signals import pre_delete
from django.dispatch import receiver

from apps.users.models import User

from . import permissions
from .models import Membership, Workspace


@receiver(pre_delete, sender=User)
def hand_over_owned_workspaces(sender, instance, **kwargs):
    """An account is being erased for good: the longest-serving admin (else editor, and so on)
    becomes owner, so a team doesn't lose its workspace. With nobody left, it goes too."""
    for owned in Membership.objects.filter(user=instance, role=permissions.OWNER).select_related("workspace"):
        rank = {role: i for i, role in enumerate(reversed(permissions.ROLE_ORDER))}
        others = list(Membership.objects.filter(workspace=owned.workspace).exclude(user=instance).filter(user__is_active=True, user__deleted_at__isnull=True))
        others.sort(key=lambda m: (rank[m.role], m.joined_at))
        owned_workspace = owned.workspace
        owned.delete()
        if others:
            Membership.objects.filter(pk=others[0].pk).update(role=permissions.OWNER)
        else:
            Workspace.all_objects.filter(pk=owned_workspace.pk).delete()
