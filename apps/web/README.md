# apps/web — Platform, веб-клиент (Next.js)

Дизайн-система по разделу 5 плана: `src/styles/tokens.css` (единственное место с литералами цветов),
`src/components/ui/*` (Button, Badge/StatusBadge/GradeBadge/DirectionBadge, Panel, Table, Input/Select,
Tooltip, EmptyState, ThemeToggle), `src/lib/format.ts` (цены по шагу, R, проценты, время `25.10 16:00 UTC`).
Витрина компонентов: `/ui`.

```
npm run dev          # http://localhost:3000
npm run check        # eslint + lint:colors + tsc + vitest
npm run lint:colors  # запрет цветов вне токенов
npm run build
```

Тема: светлая/тёмная по системе, переключатель пишет `data-theme` на `<html>` и `localStorage.theme`.
