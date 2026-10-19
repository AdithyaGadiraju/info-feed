# UI design

Set up with the `create-good-modern-ui` skill. Later sessions follow the brief below instead of re-asking.

## Design brief

| Decision | Choice |
|---|---|
| Accent | Blue `#2563eb` → generated tokens in `app/boxy.css` (light and dark blocks) |
| Shape | Boxy (default, no `data-shape`) |
| Tone | Bold (`data-tone="bold"`) |
| Density | Roomy (default) |
| Neutrals | Warm (default) |
| Font | Figtree via `next/font/google` → `--font-brand` |
| Dark mode | Opt-in toggle in the header; saved in `localStorage`, applied by a head script |
| Main device | Phone and desktop equally |
| Users | One expert reader (the owner) |
| Conditions | Normal, WCAG AA |
| App type | Content: a reading feed plus story permalinks |
| Navigation | Top bar: Feed, Design, theme toggle |
| Form labels | Not used yet; inline-label fields if forms are added |
| Long forms | None |
| Interface tone | Plain and direct |
| Required vs optional | Not used yet; mark "(optional)" if forms are added |
| Lanes | Neutral eyebrow label, no per-lane colour |
| Score | Five square pips in accent, with "Score n of 5" as the accessible name |
| Filters | Square radio chips: lane (single select) and minimum score |
| Must not change | Feed logic, URL params, API shapes, basic auth |

## Status meanings

| Colour | Meaning | Always shown with |
|---|---|---|
| Green | Fact-check confirmed | check icon + "Confirmed" |
| Amber | Fact-check unconfirmed | help icon + "Unconfirmed" |
| Red | Disputed, false, or a load error | alert or x icon + words |
| Grey | Verdict outdated (story changed since) | clock icon + ", outdated" |
| Accent | Action, link, current nav, score pips | words |
| Yellow highlight | Done / confirmed ticks only | tick |

## Rules
- Tokens only; pages never hard-code colours, radii or shadows.
- Status is never colour alone.
- Tailwind utilities do layout and spacing only; components use boxy classes.
- Real labels; fieldset + legend for chip groups; 48px tap targets.
- Mobile first; `min-width` 40em / 60em only.
- One primary button per view.
- App-specific classes (story card, pips, markdown) live in `app/globals.css`.
- Icons are inlined lucide paths in `components/Icon.tsx`; add new ones there.
- Living style guide: `/design`.

## Accent check
- All ten light and dark contrast checks PASS for `#2563eb`.
- No status-colour clash warnings.

## Glossary

| Term | Meaning |
|---|---|
| Token | A CSS variable holding a colour, size, radius or shadow. |
| Knob | An attribute on `<html>` (tone, theme) that swaps a token set. |
| Accent | The one brand colour for actions, links, focus and the current page. |
| Highlight | The yellow used only for "done" ticks. |
| Eyebrow | Small spaced capitals labelling a group, used here for lane names. |
| Pips | The five small squares that show a story's score. |
