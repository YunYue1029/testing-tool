---
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.html"
---

# UI Copy — no description under a label

Don't render a description line under a label, title, or heading:

```
Discord   [ Disabled ]
Connect Hermes to Discord DMs, channels, and threads.   ← don't write this
```

Don't use any of the elements that produce it:

- **Component slots and props** — `FormDescription`, `FieldDescription`, `CardDescription`, `DialogDescription` (shadcn); `helperText`, `FormHelperText`, `ListItemText secondary` (MUI); the `description` prop (Mantine, settings-row components); `<Description>` (Headless UI); `<Text slot="description">` (React Aria); `extra` on `Form.Item` (Ant Design); `FormHelperText` / `Field.HelperText` (Chakra).
- **Hand-written** — a muted `<p>` or `<span>` under a label or heading: `text-sm text-muted-foreground`, `.description`, `.subtitle`, `.hint`, `.help-text`, `.caption`.
- **Intro paragraphs** under a page, section, card, or modal title.

Radix `Dialog` warns when `DialogDescription` is missing — pass `aria-describedby={undefined}` to `DialogContent` instead of writing one.

If a control can't be understood from its label, rename the label.

Text under a control is allowed only when it changes with the data: a validation error (`FormMessage`), or the current status — "Last synced 2 min ago", "3 steps skipped".
