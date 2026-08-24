# SimpleClipboard Design QA

## Evidence

- The design pass used an annotated compact-panel reference and multiple local
  GNOME Shell captures covering history, images, notes, pins, and minimum-size
  layouts.
- QA captures are intentionally excluded from the repository because they may
  contain clipboard contents or other private desktop data.
- Viewport: GNOME 46 on X11, 5760 × 1080 root across three 1920 × 1080 monitors; captures are native 1× pixels.
- Normalization: source and implementation were kept at native density and placed together without stretching. The source is an annotated failure-state screenshot rather than a pixel-clone target, so the comparison judges the requested removals and resulting information density rather than exact overlay fidelity.

## Findings

No actionable P0, P1, or P2 visual differences remain for the requested iteration.

- Fonts and typography: GNOME's system UI font and symbolic icons remain consistent. The 16 px title, 13 px row copy, and 11 px metadata retain hierarchy at both 500 px and 360 px widths. Long text truncates before the action area.
- Spacing and layout rhythm: header, search, tabs, and body are visibly tighter. The persistent footer is gone, body padding is reduced, rows are approximately 58 px tall, and three real items are visible in a 376 px panel. All tabs retain the same open-session dimensions.
- Colors and visual tokens: the charcoal translucent surface, muted metadata, subtle borders, and Ubuntu orange active state still match the selected design direction. The new-note action is now a compact orange-accent icon in the header.
- Image quality and assets: real clipboard images retain their aspect ratio and sharp thumbnail treatment. At 500 px the gallery can use two columns; below 500 px it uses one column instead of crushing cards.
- Copy and content: the notes empty state now says `入力欄からメモを追加できます`, matching the composer above it. Duplicate explicit copy actions were removed because selecting the item already copies and pastes.
- Actions and affordance: history rows now reserve most horizontal space for clipboard text. Only pin and delete remain as row-side actions; the right padding keeps them clear of the overlay scrollbar.
- Responsive limits: settings now allow 360–900 px width and 280–900 px maximum height. The minimum 360 × 280 state keeps title, settings, close, search, all four tabs, and scroll content usable.
- Interaction and errors: Super+V open, Escape close, note-tab switching, image-tab switching, minimum-size relayout, and the header note entry path were exercised in GNOME Shell. The extension is active and the shell journal contains no SimpleClipboard JavaScript errors. Existing click-to-copy-and-paste behavior remains unchanged.

## Scroll Verification Note

- The implementation no longer relies on a row button bubbling its wheel event. The scroll view is reactive and owns manual mouse scrolling; every interactive row/card action explicitly forwards smooth scroll and wheel events before `St.Button` can consume them. Scroll adjustment is clamped to its real content range.
- Mutter does not translate the available XTest core button 4/5 injection into a Clutter scroll event, so synthetic wheel screenshots cannot honestly demonstrate displacement. This is recorded as an automation limitation, not used as visual pass evidence. The code covers both `Clutter.ScrollDirection` events and X11 button 4/5 fallbacks at the actual event targets.

## Comparison History

1. Annotated baseline.
   - Earlier P1: fixed header/search/tab/footer chrome consumed most of the panel and clipped content.
   - Fix: reduced header/search/tab/body padding, removed the global footer, and moved the note action into the header.
   - Post-fix evidence showed the gained content area at the same native scale.

2. Row-density review.
   - Earlier P2: 84 px leading previews plus pin/copy/delete controls left too little text width and collided visually with the scrollbar.
   - Fix: reduced previews to 64 × 46, removed the redundant copy action, tightened action padding, and reserved 10 px at the scroll edge.
   - Post-fix evidence showed three readable rows with separated actions and scrollbar.

3. Lower-bound review.
   - Earlier P2: settings prohibited widths below 500 px and heights below 420 px.
   - Fix: changed bounds to 360 × 280, compacted empty states, and added a one-column gallery breakpoint.
   - Post-fix evidence covered both history and image views at minimum size.

4. Tab and note-state review.
   - Earlier P2: a permanent note footer changed perceived density and cost vertical space on every tab.
   - Fix: the composer exists only inside the notes body; history, image, and pin states have no footer band.
   - Post-fix evidence covered the note, image, and pinned states at equal dimensions.

## Follow-up Polish

- [P3] Add real date grouping (`今日`, `昨日`, older dates) once the history model needs it.
- [P3] After a physical mouse/touchpad pass, tune the 56 px wheel step if the user's hardware feels too fast or slow.

## Final Result

final result: passed
