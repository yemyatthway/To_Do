"""Error reports may leave for Sentry, private data may not: no message text, passwords, tokens,
cookies, search terms or who was signed in. What's left (the error and the code path) is enough."""


def scrub_event(event, hint=None):
    request = event.get("request")
    if request:
        event["request"] = {key: request[key] for key in ("method", "url") if key in request}
        if "url" in event["request"]:
            event["request"]["url"] = event["request"]["url"].split("?", 1)[0]
    event.pop("user", None)
    event.pop("breadcrumbs", None)
    return event
