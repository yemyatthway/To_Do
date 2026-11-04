from django import template
from django.utils.html import conditional_escape
from django.utils.safestring import mark_safe

from apps.users.language import tr

register = template.Library()


@register.simple_tag(takes_context=True)
def say(context, text, **values):
    """Plain-text emails keep their characters; HTML ones escape what was filled in."""
    if context.autoescape:
        values = {name: conditional_escape(value) for name, value in values.items()}
        return mark_safe(tr(context.get("language", "en"), text, **values))
    return tr(context.get("language", "en"), text, **values)
