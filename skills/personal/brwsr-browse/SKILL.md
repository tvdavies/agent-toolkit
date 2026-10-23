---
name: brwsr-browse
description: Do things on websites fast in a brwsr.dev cloud browser: book, search, fill forms, check out up to payment. A fast decision model (Jev) does the clicking and typing, and you supervise, answering only when it is unsure. Use for multi-step web tasks where you know the goal and the values to enter; prefer it over driving a browser click by click.
---

# brwsr-browse

`reflex` runs a whole web task from a goal and the values to use. Its
fast loop picks each element and value with Jev (about 0.2 s and $0.0001 a
step, no LLM), and hands back to you only when it can't decide. You are the
supervisor: plan, supply the values, answer its questions, approve anything
irreversible.

CLI: `~/dev/tvdavies/brwsr/reflex/bin/reflex` (one JSON object on stdout).
Needs `BRWSR_API_KEY` and `TYPESAFE_API_KEY` in the environment, or their files
(`SAL_GRANT_BRWSR_API_KEY_FILE`, `SAL_GRANT_TYPESAFE_API_KEY_FILE`).

## Flow

```sh
reflex start --url https://www.saucedemo.com/          # → {"session": "…", "liveView": "…"}
reflex run --session S \
  --goal "Log in, add the Fleece Jacket to the cart and check out up to the order overview" \
  --data username=standard_user --data password=secret_sauce \
  --data first_name=Tom --data last_name=Davies --data postal_code="S1 2AB"
reflex stop --session S
```

`run` ends with a `status`:

| status | meaning | what you do |
| --- | --- | --- |
| `done` | the goal's end state is on the page | check `page`, carry on |
| `stopped_before` | reached `--stop-before`, payment details, or a final Pay / Purchase / Place order / Finish button | report back; commit only with Tom's go-ahead (`--allow-commit` or `act`) |
| `needs_supervisor` | it wasn't sure; `escalation` has the page, its best guesses and the elements | answer with `act`, then `run` the same goal again |
| `max_steps`, `aborted` | it went round in circles or gave up | `look`, then `act` or rephrase the goal |

## Writing a good run

- **Goal**: the end state in one sentence ("…up to the order overview").
- **Data**: every value it will type or select, with descriptive keys
  (`flying_from`, `departure_date`, not `from`, `date`). Dates in the site's
  own format where you know it ("Fri 6 Nov").
- **Plan** (`--plan`, repeatable) for long or unusual flows: short steps in
  order ("set the trip type to one way", "open the cheapest flight").
- **Stop** (`--stop-before`) when the stopping point isn't payment: "the page
  lists booking options for one flight".
- It never fills card details or presses a final commit button unless you
  pass `--allow-commit`, and card data must use keys such as `card_number`.

## Answering an escalation

`escalation.best_guesses` are its top picks with probabilities and
`escalation.elements` everything it was offered (`id` + description; `in:`
shows the card or row a look-alike button sits in). Pick one and act:

```sh
reflex act --session S 42 click
reflex act --session S 17 fill "Tom Davies"
reflex act --session S 9 select "London"
reflex act --session S press Enter     # or: goto URL, scroll
reflex run --session S --goal "<same goal>" --data …   # carry on
```

`reflex look --session S` shows the page and its elements at any time. Steps
are remembered per session (`~/.cache/reflex/`), so a second `run` knows what
was done.

Share `liveView` (or `https://brwsr.dev/sessions/S`) when Tom wants to watch.
`--context NAME` on `start` loads a saved brwsr context (logins); `--model clef`
uses Cloudflare's Clef instead of Jev; `--supervisor gpt-5.4` lets an OpenAI
model answer escalations itself, for unattended runs.
