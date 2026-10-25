import re
from zoneinfo import available_timezones

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _

SPECIAL_CHARS = r"!@#$%^&*()\-_=+\[\]{};:'\",.<>/?\\|`~"


class PasswordComplexityValidator:
    """Same rule as afm_sys: upper, lower, digit and special character."""

    def validate(self, password, user=None):
        errors = []
        if not re.search(r"[A-Z]", password):
            errors.append(_("at least one uppercase letter"))
        if not re.search(r"[a-z]", password):
            errors.append(_("at least one lowercase letter"))
        if not re.search(r"\d", password):
            errors.append(_("at least one digit"))
        if not re.search(f"[{SPECIAL_CHARS}]", password):
            errors.append(_("at least one special character"))

        if errors:
            raise ValidationError(
                _("This password must contain %(reqs)s.") % {"reqs": ", ".join(errors)},
                code="password_not_complex",
            )

    def get_help_text(self):
        return _(
            "Your password must contain at least one uppercase letter, one "
            "lowercase letter, one digit, and one special character."
        )


_TIMEZONES = None


def is_valid_timezone(name):
    global _TIMEZONES
    if _TIMEZONES is None:
        _TIMEZONES = available_timezones()
    return name in _TIMEZONES
