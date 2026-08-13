# LongConext — Alex vs. DMV

A React JS demo of a **long-running civic agent**: one citizen, one department, one case that actually gets complicated.

The product is not a chatbot. It is an advocate that stays on a single DMV registration hold for 11 days — diagnosing the real problem, fighting a dispute the citizen would give up on, and catching a second deadline the citizen forgot about.

---

## The trick

Depth without confusion: **strictly two parties**.

| Party | Role |
| --- | --- |
| **Alex** | One citizen trying to renew registration |
| **DMV** | One institutional counterpart (portal, toll line, dispute office, supervisor) |

The case itself gets genuinely complicated over time, the way real DMV cases do. Judges can track “Alex vs. DMV” across every twist because there is never a third character to hold in their head.

The rental agency is a *fact in the record*, not a character on stage. The agent never talks to them. It only uses that paperwork error as evidence against DMV.

---

## Why this case

Real DMV failure mode: the public portal shows **one error at a time**. Alex spent weeks chasing a smog check that was never the blocking issue. The agent’s first value is not fixing anything — it is correctly diagnosing a problem the citizen did not know he had.

Then the case earns its length:

- Days 2–5: the agent investigates instead of bouncing Alex back to a phone tree
- Days 5–11: six days of DMV silence — the watchdog applies pressure a citizen alone never would
- Day 11: the hold clears, *and* the agent catches the smog window that is about to expire

Three capabilities, in sequence, each a standalone “wow” beat:

1. **Diagnosis** — find the real problem (toll hold, not smog)
2. **Advocacy** — dispute on Alex’s behalf, then escalate when DMV goes quiet
3. **Proactive risk-catching** — remember the smog deadline Alex forgot

The long-running payoff is concrete: an **11-day case** with one **6-day silent stretch** the agent alone pushed through. Easy to show as a timeline with one stall, not three overlapping ones.

---

## The 11-day journey

### Day 1 — The block isn’t what Alex thinks it is

Alex tries to renew online. Rejected. He assumes it’s the smog check — that’s the error message.

The agent checks the backend directly and finds something Alex didn’t know: the smog check is fine. There is a separate, older hold — an unpaid toll violation from eight months ago, silently attached to his registration. The portal only ever shows one error at a time, so Alex has been fixing the wrong problem for weeks before this case even opened.

**Agent acts.** It tells Alex the real issue (toll violation, not smog) and asks whether he wants to pay it, dispute it, or needs more information.

Alex says he doesn’t recognize the toll at all. He thinks it’s a mistake.

### Days 2–5 — The agent goes and checks, instead of just relaying

Instead of telling Alex “you’ll have to dispute it yourself,” the agent:

- Calls the DMV toll-violation line on his behalf
- Pulls the violation record
- Finds it is tied to a rental car Alex drove months ago that was never re-registered to the rental company properly — a paperwork error on the rental agency’s side, not Alex’s

The agent does not just report this back. It drafts the dispute from the details it already gathered, submits it through DMV’s dispute process, and watches for a response.

### Days 5–11 — Silence from DMV’s dispute office

No response for six days. This is where watchdog logic shows real teeth: it is not the citizen who is slow this time, it is the department.

The agent escalates on its own — calls the dispute line again, then asks for supervisor review, citing how long the case has been open.

This is the moment that separates **reminder bot** from **advocate**. It applies pressure a citizen alone never would, because most people give up after one unanswered call.

### Day 11 — Resolution, with a twist Alex doesn’t expect

The dispute is approved. The toll charge is removed.

The agent also flags something proactively: because the hold is now cleared, the original smog requirement (the one Alex thought was the whole problem) is still outstanding and about to expire its **90-day window in two days**.

The agent calls Alex directly — **voice**, because it is now time-sensitive — so he doesn’t lose the whole renewal over a second requirement he had forgotten about entirely.

### Day 11, final — Registration clears

Alex uploads the smog cert the same day via a text link. The agent verifies it. Registration clears.

---

## What the React app should show

One screen, one case file. The UI never introduces a third person.

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  Case #REG-88421     Alex Chen  ×  CA DMV               │
│  Registration renewal  ·  Day 11 of 11  ·  Resolved     │
├──────────────┬──────────────────────────────────────────┤
│  TIMELINE    │  CASE FILE                               │
│              │                                          │
│  Day 1  ●    │  Holds                                    │
│  Day 2  ●    │  • Toll violation (cleared)               │
│  Day 5  ○    │  • Smog cert (verified)                   │
│  (silence)   │                                          │
│  Day 11 ●    │  Agent actions                            │
│              │  Diagnose → Dispute → Escalate → Call     │
│              │                                          │
│              │  Transcript / voice / upload              │
└──────────────┴──────────────────────────────────────────┘
```

### Screens / states to build

1. **Portal lie** — Alex’s online renewal error (“smog required”) vs. the agent’s backend view (toll hold is the real block).
2. **Choice** — Pay / Dispute / Need more info. Alex picks dispute.
3. **Investigation** — Agent-side call log + violation record (rental-car paperwork error).
4. **Watchdog stall** — Timeline goes quiet for six days; agent auto-escalates to supervisor.
5. **Voice beat** — Same-day smog deadline; agent calls Alex.
6. **Close** — Text-link upload, verification, registration clear.

### Suggested stack

- React + Vite
- Case state as a single JSON document (below) driving the timeline
- No extra characters, no extra agencies on screen
- Voice and SMS can be mocked for the 3-minute demo, then swapped for real Twilio / similar

---

## Canonical case JSON

Seed data for the React app. One citizen. One department. One stall.

```json
{
  "caseId": "REG-88421",
  "title": "Registration renewal hold",
  "parties": {
    "citizen": {
      "id": "alex-chen",
      "name": "Alex Chen",
      "phone": "+1-555-0142"
    },
    "department": {
      "id": "ca-dmv",
      "name": "CA DMV"
    }
  },
  "durationDays": 11,
  "status": "resolved",
  "capabilitiesShown": ["diagnosis", "advocacy", "proactive_risk_catch"],
  "holds": [
    {
      "id": "toll-hold",
      "label": "Unpaid toll violation",
      "origin": "rental_car_not_reassigned",
      "ageMonths": 8,
      "visibleInPortal": false,
      "status": "cleared",
      "clearedOnDay": 11
    },
    {
      "id": "smog",
      "label": "Smog certification",
      "visibleInPortal": true,
      "status": "verified",
      "windowDays": 90,
      "daysRemainingWhenTollCleared": 2
    }
  ],
  "timeline": [
    {
      "day": 1,
      "beat": "misdiagnosis",
      "capability": "diagnosis",
      "summary": "Alex renews online, sees smog error. Agent checks backend: smog is fine; older toll hold is the real block.",
      "actor": "agent",
      "actions": [
        "Read public portal error (smog)",
        "Query registration backend",
        "Surface hidden toll hold from 8 months ago",
        "Explain real issue to Alex",
        "Offer pay / dispute / more info"
      ],
      "alexResponse": "I don't recognize this toll. I think it's a mistake."
    },
    {
      "day": "2-5",
      "beat": "investigate_and_file",
      "capability": "advocacy",
      "summary": "Agent calls DMV toll line, pulls the record, finds rental-car paperwork error, drafts and submits the dispute.",
      "actor": "agent",
      "actions": [
        "Call DMV toll-violation line on Alex's behalf",
        "Pull violation record",
        "Identify rental-car re-registration error (evidence, not a third character)",
        "Draft dispute from gathered details",
        "Submit through DMV dispute process",
        "Watch for response"
      ]
    },
    {
      "day": "5-11",
      "beat": "watchdog_silence",
      "capability": "advocacy",
      "summary": "Six days of no response from DMV dispute office. Agent escalates on its own to supervisor review.",
      "actor": "agent",
      "stallDays": 6,
      "actions": [
        "Detect no DMV response for 6 days",
        "Call dispute line again",
        "Request supervisor review",
        "Cite case age as grounds for escalation"
      ],
      "note": "This is the reminder-bot vs advocate split. Pressure a citizen alone would not apply."
    },
    {
      "day": 11,
      "beat": "resolution_plus_risk",
      "capability": "proactive_risk_catch",
      "summary": "Dispute approved, toll hold cleared. Agent flags smog window expiring in 2 days and calls Alex by voice.",
      "actor": "agent",
      "channel": "voice",
      "actions": [
        "Confirm dispute approved",
        "Clear toll hold",
        "Detect smog 90-day window expires in 2 days",
        "Call Alex (voice, time-sensitive)",
        "Send SMS upload link for smog cert"
      ]
    },
    {
      "day": 11,
      "beat": "close",
      "capability": "proactive_risk_catch",
      "summary": "Alex uploads smog cert same day via text link. Agent verifies. Registration clears.",
      "actor": "alex",
      "channel": "sms",
      "actions": [
        "Alex uploads smog certificate",
        "Agent verifies document",
        "Registration hold fully cleared"
      ]
    }
  ]
}
```

---

## Why judges can follow this in 3 minutes

- Two names on the case header the whole time: **Alex** and **DMV**
- One timeline, one stall (days 5–11), not three overlapping plots
- Three beats that each stand alone if the demo has to cut short:
  1. “The portal was lying.”
  2. “The agent didn’t bounce him — it filed the dispute, then escalated.”
  3. “The hold cleared and the agent still called, because smog was about to expire.”

---

## Next artifacts

This README is the product idea and the canonical case.

Still useful to add next:

- **Structured case JSON** as `src/data/alex-vs-dmv.json` (the blob above, loaded by the app)
- **3-minute stage script** built directly from these beats (what you say, what the UI shows, when the voice call happens)
