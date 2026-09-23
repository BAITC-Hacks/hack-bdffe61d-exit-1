from __future__ import annotations

import re
from datetime import date, timedelta

RU_WEEKDAYS = {
    "понедельник": 0,
    "понедельника": 0,
    "понедельнику": 0,
    "вторник": 1,
    "вторника": 1,
    "вторнику": 1,
    "среда": 2,
    "среды": 2,
    "среде": 2,
    "четверг": 3,
    "четверга": 3,
    "четвергу": 3,
    "пятница": 4,
    "пятницы": 4,
    "пятнице": 4,
    "суббота": 5,
    "субботы": 5,
    "субботе": 5,
    "воскресенье": 6,
    "воскресенья": 6,
}

KK_WEEKDAYS = {
    "дүйсенбі": 0,
    "дүйсенбіге": 0,
    "сейсенбі": 1,
    "сейсенбіге": 1,
    "сәрсенбі": 2,
    "сәрсенбіге": 2,
    "бейсенбі": 3,
    "бейсенбіге": 3,
    "жұма": 4,
    "жұмаға": 4,
    "сенбі": 5,
    "сенбіге": 5,
    "жексенбі": 6,
    "жексенбіге": 6,
}


def _next_weekday(base: date, weekday: int, force_next: bool = False) -> date:
    delta = (weekday - base.weekday()) % 7
    if force_next and delta == 0:
        delta = 7
    return base + timedelta(days=delta)


def resolve_due_date(raw: str | None, meeting_date: date) -> date | None:
    """Resolve common Russian/Kazakh deadline phrases deterministically."""
    if not raw:
        return None
    value = " ".join(raw.casefold().replace("ё", "е").split())

    iso_match = re.search(r"\b(20\d{2})-(\d{1,2})-(\d{1,2})\b", value)
    if iso_match:
        try:
            return date(*map(int, iso_match.groups()))
        except ValueError:
            return None

    dotted_match = re.search(r"\b(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}|\d{2}))?\b", value)
    if dotted_match:
        day, month, year_raw = dotted_match.groups()
        year = meeting_date.year if year_raw is None else int(year_raw)
        if year < 100:
            year += 2000
        try:
            candidate = date(year, int(month), int(day))
            if year_raw is None and candidate < meeting_date:
                candidate = date(year + 1, int(month), int(day))
            return candidate
        except ValueError:
            return None

    if any(marker in value for marker in ("послезавтра", "бүрсігүні", "арғы күні")):
        return meeting_date + timedelta(days=2)
    if any(marker in value for marker in ("завтра", "ертең")):
        return meeting_date + timedelta(days=1)
    if any(marker in value for marker in ("сегодня", "бүгін")):
        return meeting_date

    days_match = re.search(r"через\s+(\d+)\s+д", value)
    if days_match:
        return meeting_date + timedelta(days=int(days_match.group(1)))
    kk_days_match = re.search(r"(\d+)\s*күн(?:нен|нен кейін| ішінде)", value)
    if kk_days_match:
        return meeting_date + timedelta(days=int(kk_days_match.group(1)))

    if any(marker in value for marker in ("до конца следующей недели", "келесі аптаның соңына")):
        return meeting_date + timedelta(days=(13 - meeting_date.weekday()))
    if any(
        marker in value
        for marker in ("до конца недели", "концу недели", "апта соңына", "аптаның соңына")
    ):
        return meeting_date + timedelta(days=(6 - meeting_date.weekday()))
    if any(
        marker in value for marker in ("на следующей неделе", "следующую неделю", "келесі апта")
    ):
        return meeting_date + timedelta(days=(7 - meeting_date.weekday()))

    force_next = any(marker in value for marker in ("следующ", "келесі"))
    for word, weekday in {**RU_WEEKDAYS, **KK_WEEKDAYS}.items():
        if re.search(rf"\b{re.escape(word)}\b", value):
            return _next_weekday(meeting_date, weekday, force_next=force_next)
    return None
