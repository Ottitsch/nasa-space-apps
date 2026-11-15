# Take action: city files

The "take action" pages (report, letter, find the others) work for every place
on the map. For some cities they go further: they name who is responsible, how
to reach them, which law obliges them to answer, and where neighbours organise.
That knowledge lives here, one JSON file per city, so it can be checked and
corrected by people who live there without touching any code.

```
cities/<place id>.json     who is responsible in one city (schema below)
i18n/<language>.json       every sentence of the pages and letters in one language
```

`<place id>` is the id used in `pipeline/places.json` (for example `mexico-city`).

## City file schema

Text meant for residents is given per language: `{ "en": "...", "es": "..." }`.
Always include `en`, plus every language listed in `languages`.

```json
{
  "id": "mexico-city",
  "checked": "2026-11-14",
  "languages": ["es"],
  "place_name": { "en": "Mexico City", "es": "Ciudad de México" },
  "country_name": { "en": "Mexico", "es": "México" },
  "summary": { "en": "Two or three plain sentences: who is in charge of what here.", "es": "..." },
  "bodies": [
    {
      "id": "short-key",
      "name": "Official name in the local language",
      "name_en": "English name",
      "level": "district | city | state | national",
      "handles": ["inspection"],
      "role": { "en": "One sentence: what they are responsible for and why a resident writes to them.", "es": "..." },
      "website": "https://official.site",
      "contact_url": "https://official.site/page-with-contact-form-or-details",
      "email": null,
      "phone": null,
      "postal": null,
      "source": "https://official page where these contact details were read"
    }
  ],
  "right_to_answer": {
    "name": "Name of the law or mechanism in the local language",
    "name_en": "English name",
    "what": { "en": "What it obliges the authority to do, and by when.", "es": "..." },
    "how": { "en": "How a resident files a request: which portal or office.", "es": "..." },
    "url": "https://official portal",
    "asks": ["inspection", "groundwater"],
    "deadline_days": 20,
    "deadline_text": { "en": "20 working days", "es": "20 días hábiles" },
    "source": "https://official source for the law or deadline"
  },
  "urgent": {
    "phone": "911",
    "what": { "en": "Who to call when a building looks about to fail.", "es": "..." },
    "source": "https://official source"
  },
  "context": {
    "en": "Two to four sentences: what is publicly known about sinking here and any official monitoring or programme.",
    "es": "...",
    "sources": ["https://..."]
  },
  "organising": {
    "telegram_usable": true,
    "note": { "en": "Is Telegram reachable here, what neighbourhood groups normally use, and anything people should be careful about.", "es": "..." },
    "sources": ["https://..."]
  },
  "platforms": ["whatsapp", "telegram"],
  "group_name": { "en": "Sinking Ground Mexico City", "es": "Hundimiento Ciudad de México" },
  "groups": []
}
```

Field notes:

* `handles` says which letter fits the body. `inspection`: checks buildings or
  ground on site (civil protection, building safety, municipal works).
  `groundwater`: regulates or operates pumping, or monitors the sinking (water
  utility, groundwater regulator, geological survey). `information`: the
  office or portal that takes formal information requests.
* `bodies`: three to six, most useful first. Include at least one `inspection`
  and one `groundwater` body. If responsibility sits with districts or
  municipalities inside the metro area, add one entry that points to the
  official directory of those offices.
* `email`, `phone`, `postal`: only what is printed on an official page (give
  that page in `source`). Otherwise `null`. Never guess or build an address
  from a pattern.
* `right_to_answer`: the access to information or petition mechanism that
  legally obliges a reply. `null` if there is none. `deadline_text` is the
  deadline as a short phrase that says whether the days are working days.
  `asks` lists the letters that may cite it. Leave it out for a plain access
  to information law (it then backs the groundwater letter only, which is a
  request for information). List `inspection` too only when the mechanism
  also obliges a reply to a request for action, such as a right of petition.
* `platforms`: the apps neighbourhood groups use here, most used first. One or
  more of whatsapp, telegram, wechat, bale, rubika, eitaa, element, signal,
  viber, facebook, email. `organise.html` tells people to start the group on
  the first one and lists the others.
* `group_name`: the name to give a new group, in English and every language in
  `languages`. Shown with a copy button on `organise.html`.
* `groups`: filled in by the project owners once a group exists, for example
  `[{ "platform": "telegram", "url": "https://t.me/...", "label": "Sinking Ground Mexico City" }]`.
* `checked`: the day the contacts were last confirmed on the official pages.

Contacts go stale. Anyone who knows a city can correct its file in a pull
request; the pages pick the change up without any code change.

## Adding a group

When someone starts a group for a city (they can send the link through the
"send the link" button on `organise.html`, which opens a GitHub issue), and
whoever runs it agrees to list it:

```bash
python3 web/action/add_group.py chennai whatsapp https://chat.whatsapp.com/...
```

It adds the link to the city file. Run `python3 web/action/check.py` and commit.
The group then shows with a Join button on `organise.html` and in step 3 of the
take action page. `cities/index.json` lists every city file for
`organise.html`; the checker makes sure it stays complete. Links that every
city shares (the Element space for organisers, the email list) go in
`community.json`.
