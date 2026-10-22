# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-07-20
- Primary product surfaces: lobby, answer entry, judging/reveal, round results, game over
- Evidence reviewed: `README.md`, `src/pages/GameRoom.tsx`, `src/index.css`, `tailwind.config.ts`

## Brand
- Personality: playful, energetic party game with a cinematic reveal.
- Trust signals: clear roles, visible connection state, immediate feedback for votes and reactions.
- Avoid: visual noise that hides answer text, abrupt motion, ambiguous controls.

## Product goals
- Goals: keep the group focused on one reveal at a time; make lightweight social feedback fun and immediate.
- Non-goals: reactions do not affect scoring or round choices.
- Success signals: players understand the reveal order and can react to every displayed answer.

## Personas and jobs
- Primary personas: a host/leader running a round and players participating from phones.
- User jobs: submit an answer, follow the reveal, react, vote, and understand the current action.
- Key contexts of use: shared room, mobile devices, intermittent network conditions.

## Information architecture
- Primary navigation: single-room flow with phase-driven screens.
- Core routes/screens: home and game room.
- Content hierarchy: phase/round context, question, leader answer, player answers, decision controls.

## Design principles
- Reveal one focal item at a time.
- Keep reactions expressive but secondary to answer text and scoring actions.
- Tradeoffs: cinematic pacing is preferred over showing all judging controls immediately.

## Visual language
- Color: reuse the existing dark theme, primary/accent tokens, and answer-card tone variants.
- Typography: reuse display headings and readable body text already defined by the app.
- Spacing/layout rhythm: compact mobile-first cards with existing Tailwind spacing.
- Shape/radius/elevation: rounded cards and pill-shaped reaction controls.
- Motion: soft spring easing, short stagger, and a two-second dramatic pause after the leader answer.
- Imagery/iconography: existing Lucide icons and native emoji reactions.

## Components
- Existing components to reuse: cards, buttons, answer reaction picker, reaction summary.
- New/changed components: reaction-enabled leader-answer card and reveal timing.
- Variants and states: closed/open reaction cloud, selected reactions, reduced-motion behavior.
- Token/component ownership: Tailwind utilities and animation classes in `src/index.css`.

## Accessibility
- Target standard: preserve semantic buttons, labels, and readable contrast.
- Keyboard/focus behavior: reaction controls remain real buttons with `aria-pressed`.
- Contrast/readability: answer text remains the highest-priority content.
- Screen-reader semantics: reaction groups and counts retain accessible labels.
- Reduced motion and sensory considerations: reveal and reaction animations are disabled when reduced motion is requested.

## Responsive behavior
- Supported breakpoints/devices: phone-first layout with existing `sm` and `md` adaptations.
- Layout adaptations: single-column cards on mobile, two-column player-answer grid on wider screens.
- Touch/hover differences: long press or context menu opens reactions; buttons support pointer and keyboard activation.

## Interaction states
- Loading: existing connection and synchronization notices.
- Empty: leader answer falls back to an em dash.
- Error: existing room-level error handling.
- Success: selected reactions and counts update from server state.
- Disabled: judging actions remain unavailable until the reveal completes.
- Offline/slow network, if applicable: actions continue through the existing queued synchronization flow.

## Content voice
- Tone: direct, playful, and concise.
- Terminology: “ответ ведущего”, “ответы игроков”, “реакции”.
- Microcopy rules: explain that reactions are independent from scoring when guidance is shown.

## Implementation constraints
- Framework/styling system: React, TypeScript, Tailwind CSS, and repo-local CSS animations.
- Design-token constraints: reuse existing colors and card styles.
- Performance constraints: CSS transforms/opacity for motion; no new dependencies.
- Compatibility constraints: pointer, touch, keyboard, and reduced-motion support.
- Test/screenshot expectations: server behavior covered by Vitest; client verified by build and lint.

## Open questions
- [ ] Validate the exact reveal pacing with a real group session; owner: product; impact: animation constants only.
