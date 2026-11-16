# swiftmark-r5b

A fast, dependency-free Markdown renderer that returns byte-for-byte the HTML
marked 18.1.3 produces with its default options (GFM on). Single-pass
direct-to-HTML parser; the inline scanner is index-based (no giant text
regex) with sticky dispatch on the next special character.

## Run it

```sh
node main.ts
```

Reads `/input/cases.json`, writes `/output/html.json`.
`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the paths outside a
container.
